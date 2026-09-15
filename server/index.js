import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { Server } from 'socket.io';

import { pool } from './db.js';
import {
  auth,
  roles,
  comparePassword,
  hashPassword,
  sign
} from './auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = Number(process.env.PORT) || 3000;

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const id = () => crypto.randomUUID();

const number = value => Number(value || 0);

const money = value =>
  Math.round(number(value) * 100) / 100;

function errorResponse(res, status, message) {
  return res.status(status).json({
    error: message
  });
}

async function audit(
  actorId,
  action,
  entity,
  entityId = null,
  tableNumber = null,
  beforeData = null,
  afterData = null,
  client = pool
) {
  await client.query(
    `
      INSERT INTO audit_logs
      (
        actor_id,
        action,
        entity,
        entity_id,
        table_number,
        before_data,
        after_data
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      actorId || null,
      action,
      entity,
      entityId,
      tableNumber,
      beforeData,
      afterData
    ]
  );
}

function notifyChange() {
  io.emit('state:changed');
}

/* =========================================================
   HEALTH
========================================================= */

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      service: 'rc-espeto-central'
    });
  } catch (error) {
    console.error(error);

    res.status(503).json({
      ok: false,
      error: 'Banco de dados indisponível.'
    });
  }
});

/* =========================================================
   AUTENTICAÇÃO
========================================================= */

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(
      req.body?.username || ''
    ).trim();

    const password = String(
      req.body?.password || ''
    );

    if (!username || !password) {
      return errorResponse(
        res,
        400,
        'Usuário e senha são obrigatórios.'
      );
    }

    const result = await pool.query(
      `
        SELECT
          id,
          name,
          username,
          password_hash,
          role,
          active
        FROM users
        WHERE username = $1
      `,
      [username]
    );

    const user = result.rows[0];

    if (
      !user ||
      !user.active ||
      !(await comparePassword(
        password,
        user.password_hash
      ))
    ) {
      return errorResponse(
        res,
        401,
        'Usuário ou senha inválidos.'
      );
    }

    const token = sign(user);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error(error);

    errorResponse(
      res,
      500,
      'Erro ao realizar login.'
    );
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          id,
          name,
          username,
          role,
          active
        FROM users
        WHERE id = $1
      `,
      [req.user.sub]
    );

    const user = result.rows[0];

    if (!user || !user.active) {
      return errorResponse(
        res,
        401,
        'Sessão inválida ou usuário inativo.'
      );
    }

    res.json(user);
  } catch (error) {
    console.error(error);

    errorResponse(
      res,
      500,
      'Erro ao verificar sessão.'
    );
  }
});

/* =========================================================
   MESAS
========================================================= */

app.get('/api/tables', auth, async (req, res) => {
  try {
    const params = [];
    let waiterFilter = '';

    if (req.user.role === 'GARCOM') {
      params.push(req.user.sub);

      waiterFilter = `
        AND (
          o.waiter_id = $1
          OR o.id IS NULL
        )
      `;
    }

    const result = await pool.query(
      `
        SELECT
          t.id,
          t.number,
          t.status,

          o.id AS order_id,
          o.waiter_id,
          o.total,

          u.name AS waiter,

          COALESCE(
            (
              SELECT SUM(p.amount)
              FROM payments p
              WHERE p.order_id = o.id
            ),
            0
          ) AS paid

        FROM dining_tables t

        LEFT JOIN LATERAL (
          SELECT *
          FROM orders ox
          WHERE
            ox.table_id = t.id
            AND ox.status = 'ABERTO'
          ORDER BY ox.opened_at DESC
          LIMIT 1
        ) o ON true

        LEFT JOIN users u
          ON u.id = o.waiter_id

        WHERE
          t.active = true
          ${waiterFilter}

        ORDER BY t.number
      `,
      params
    );

    res.json(
      result.rows.map(row => ({
        ...row,
        total: number(row.total),
        paid: number(row.paid)
      }))
    );
  } catch (error) {
    console.error(error);

    errorResponse(
      res,
      500,
      'Erro ao carregar mesas.'
    );
  }
});

/* =========================================================
   ABRIR MESA
========================================================= */

app.post('/api/tables/:id/open', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const tableResult = await client.query(
      `
        SELECT *
        FROM dining_tables
        WHERE
          id = $1
          AND active = true
        FOR UPDATE
      `,
      [req.params.id]
    );

    const table = tableResult.rows[0];

    if (!table) {
      throw new Error('Mesa não encontrada.');
    }

    if (table.status !== 'LIVRE') {
      throw new Error(
        'A mesa não está livre.'
      );
    }

    let waiterId = req.user.sub;

    if (
      req.user.role !== 'GARCOM' &&
      req.body?.waiter_id
    ) {
      const waiterResult = await client.query(
        `
          SELECT id
          FROM users
          WHERE
            id = $1
            AND role = 'GARCOM'
            AND active = true
        `,
        [req.body.waiter_id]
      );

      if (!waiterResult.rows[0]) {
        throw new Error(
          'Garçom responsável inválido.'
        );
      }

      waiterId = waiterResult.rows[0].id;
    }

    const orderId = id();

    await client.query(
      `
        INSERT INTO orders
        (
          id,
          table_id,
          waiter_id,
          status
        )
        VALUES
        ($1,$2,$3,'ABERTO')
      `,
      [
        orderId,
        table.id,
        waiterId
      ]
    );

    await client.query(
      `
        UPDATE dining_tables
        SET status = 'OCUPADA'
        WHERE id = $1
      `,
      [table.id]
    );

    await audit(
      req.user.sub,
      'ABRIR_MESA',
      'orders',
      orderId,
      table.number,
      null,
      {
        table_id: table.id,
        waiter_id: waiterId
      },
      client
    );

    await client.query('COMMIT');

    notifyChange();

    res.status(201).json({
      id: orderId
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error(error);

    errorResponse(
      res,
      400,
      error.message
    );
  } finally {
    client.release();
  }
});

/* =========================================================
   BUSCAR COMANDA DA MESA
========================================================= */

app.get(
  '/api/tables/:id/order',
  auth,
  async (req, res) => {
    try {
      let result = await pool.query(
        `
          SELECT id
          FROM orders
          WHERE
            table_id = $1
            AND status = 'ABERTO'
          ORDER BY opened_at DESC
          LIMIT 1
        `,
        [req.params.id]
      );

      if (!result.rows[0]) {
        result = await pool.query(
          `
            SELECT id
            FROM orders
            WHERE
              id = $1
              AND status = 'ABERTO'
          `,
          [req.params.id]
        );
      }

      const orderId = result.rows[0]?.id;

      if (!orderId) {
        return errorResponse(
          res,
          404,
          'Comanda aberta não encontrada.'
        );
      }

      const order = await getCompleteOrder(
        orderId
      );

      if (
        req.user.role === 'GARCOM' &&
        order.waiter_id !== req.user.sub
      ) {
        return errorResponse(
          res,
          403,
          'Essa mesa pertence a outro garçom.'
        );
      }

      res.json(order);
    } catch (error) {
      console.error(error);

      errorResponse(
        res,
        500,
        'Erro ao carregar comanda.'
      );
    }
  }
);

/* =========================================================
   FUNÇÃO: BUSCAR COMANDA COMPLETA
========================================================= */

async function getCompleteOrder(orderId) {
  const orderResult = await pool.query(
    `
      SELECT
        o.*,
        t.number AS table_number,
        u.name AS waiter

      FROM orders o

      JOIN dining_tables t
        ON t.id = o.table_id

      JOIN users u
        ON u.id = o.waiter_id

      WHERE o.id = $1
    `,
    [orderId]
  );

  const order = orderResult.rows[0];

  if (!order) {
    return null;
  }

  const itemsResult = await pool.query(
    `
      SELECT
        id,
        product_id,
        product_name,
        unit_price,
        quantity,
        status,
        created_at
      FROM order_items
      WHERE order_id = $1
      ORDER BY created_at,id
    `,
    [orderId]
  );

  const paymentsResult = await pool.query(
    `
      SELECT
        p.id,
        p.method,
        p.amount,
        p.created_at,
        u.name AS created_by_name
      FROM payments p

      JOIN users u
        ON u.id = p.created_by

      WHERE p.order_id = $1

      ORDER BY p.created_at,p.id
    `,
    [orderId]
  );

  const paid = money(
    paymentsResult.rows.reduce(
      (total, payment) =>
        total + number(payment.amount),
      0
    )
  );

  const total = money(order.total);

  return {
    ...order,

    subtotal: number(order.subtotal),
    discount: number(order.discount),
    additions: number(order.additions),
    service_fee: number(order.service_fee),
    total,

    items: itemsResult.rows.map(item => ({
      ...item,
      unit_price: number(item.unit_price),
      quantity: number(item.quantity)
    })),

    payments: paymentsResult.rows.map(payment => ({
      ...payment,
      amount: number(payment.amount)
    })),

    paid,

    remaining: money(
      Math.max(0, total - paid)
    )
  };
}

/* =========================================================
   PRODUTOS
========================================================= */

app.get('/api/products', auth, async (_req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          p.id,
          p.category_id,
          p.name,
          p.description,
          p.price,
          p.active,
          c.name AS category

        FROM products p

        LEFT JOIN categories c
          ON c.id = p.category_id

        ORDER BY
          p.active DESC,
          c.name NULLS LAST,
          p.name
      `
    );

    res.json(
      result.rows.map(product => ({
        ...product,
        price: number(product.price)
      }))
    );
  } catch (error) {
    console.error(error);

    errorResponse(
      res,
      500,
      'Erro ao carregar produtos.'
    );
  }
});

app.post(
  '/api/products',
  auth,
  roles('ADMIN'),
  async (req, res) => {
    try {
      const name = String(
        req.body?.name || ''
      ).trim();

      const price = Number(
        req.body?.price
      );

      const categoryName = String(
        req.body?.category || 'Outros'
      ).trim();

      if (
        !name ||
        !Number.isFinite(price) ||
        price < 0
      ) {
        return errorResponse(
          res,
          400,
          'Nome e preço válidos são obrigatórios.'
        );
      }

      let category = await pool.query(
        `
          SELECT id
          FROM categories
          WHERE name = $1
        `,
        [categoryName]
      );

      if (!category.rows[0]) {
        category = await pool.query(
          `
            INSERT INTO categories
            (
              id,
              name
            )
            VALUES
            ($1,$2)
            RETURNING id
          `,
          [
            id(),
            categoryName
          ]
        );
      }

      const result = await pool.query(
        `
          INSERT INTO products
          (
            id,
            category_id,
            name,
            price
          )
          VALUES
          ($1,$2,$3,$4)
          RETURNING *
        `,
        [
          id(),
          category.rows[0].id,
          name,
          price
        ]
      );

      await audit(
        req.user.sub,
        'CRIAR_PRODUTO',
        'products',
        result.rows[0].id,
        null,
        null,
        result.rows[0]
      );

      res.status(201).json(
        result.rows[0]
      );
    } catch (error) {
      console.error(error);

      errorResponse(
        res,
        400,
        'Não foi possível criar o produto.'
      );
    }
  }
);

app.patch(
  '/api/products/:id',
  auth,
  roles('ADMIN'),
  async (req, res) => {
    try {
      const oldResult = await pool.query(
        `
          SELECT *
          FROM products
          WHERE id = $1
        `,
        [req.params.id]
      );

      const old = oldResult.rows[0];

      if (!old) {
        return errorResponse(
          res,
          404,
          'Produto não encontrado.'
        );
      }

      const price =
        req.body?.price === undefined
          ? null
          : Number(req.body.price);

      const active =
        req.body?.active === undefined
          ? null
          : Boolean(req.body.active);

      const result = await pool.query(
        `
          UPDATE products
          SET
            price = COALESCE($1,price),
            active = COALESCE($2,active),
            updated_at = now()
          WHERE id = $3
          RETURNING *
        `,
        [
          price,
          active,
          req.params.id
        ]
      );

      await audit(
        req.user.sub,
        'EDITAR_PRODUTO',
        'products',
        req.params.id,
        null,
        old,
        result.rows[0]
      );

      res.json(
        result.rows[0]
      );
    } catch (error) {
      console.error(error);

      errorResponse(
        res,
        400,
        'Não foi possível editar o produto.'
      );
    }
  }
);

/* =========================================================
   USUÁRIOS
========================================================= */

app.get(
  '/api/users',
  auth,
  roles('ADMIN', 'CAIXA'),
  async (_req, res) => {
    try {
      const result = await pool.query(
        `
          SELECT
            id,
            name,
            username,
            role,
            active,
            created_at
          FROM users
          ORDER BY name
        `
      );

      res.json(result.rows);
    } catch (error) {
      console.error(error);

      errorResponse(
        res,
        500,
        'Erro ao carregar usuários.'
      );
    }
  }
);

app.post(
  '/api/users',
  auth,
  roles('ADMIN'),
  async (req, res) => {
    try {
      const {
        name,
        username,
        password,
        role
      } = req.body || {};

      if (
        !name ||
        !username ||
        !password ||
        !['ADMIN', 'CAIXA', 'GARCOM'].includes(role)
      ) {
        return errorResponse(
          res,
          400,
          'Dados de usuário inválidos.'
        );
      }

      const userId = id();

      const passwordHash =
        await hashPassword(password);

      const result = await pool.query(
        `
          INSERT INTO users
          (
            id,
            name,
            username,
            password_hash,
            role
          )
          VALUES
          ($1,$2,$3,$4,$5)

          RETURNING
            id,
            name,
            username,
            role,
            active
        `,
        [
          userId,
          name,
          username,
          passwordHash,
          role
        ]
      );

      await audit(
        req.user.sub,
        'CRIAR_USUARIO',
        'users',
        userId,
        null,
        null,
        result.rows[0]
      );

      res.status(201).json(
        result.rows[0]
      );
    } catch (error) {
      console.error(error);

      errorResponse(
        res,
        400,
        'Não foi possível criar o usuário. O nome de usuário pode já existir.'
      );
    }
  }
);

app.patch(
  '/api/users/:id',
  auth,
  roles('ADMIN'),
  async (req, res) => {
    try {
      const oldResult = await pool.query(
        `
          SELECT
            id,
            name,
            username,
            role,
            active
          FROM users
          WHERE id = $1
        `,
        [req.params.id]
      );

      const old = oldResult.rows[0];

      if (!old) {
        return errorResponse(
          res,
          404,
          'Usuário não encontrado.'
        );
      }

      const result = await pool.query(
        `
          UPDATE users
          SET
            active = $1,
            updated_at = now()
          WHERE id = $2

          RETURNING
            id,
            name,
            username,
            role,
            active
        `,
        [
          Boolean(req.body?.active),
          req.params.id
        ]
      );

      await audit(
        req.user.sub,
        'ALTERAR_USUARIO',
        'users',
        req.params.id,
        null,
        old,
        result.rows[0]
      );

      res.json(
        result.rows[0]
      );
    } catch (error) {
      console.error(error);

      errorResponse(
        res,
        400,
        'Não foi possível alterar o usuário.'
      );
    }
  }
);

/* =========================================================
   RECALCULAR COMANDA
========================================================= */

async function recalculateOrder(
  orderId,
  client
) {
  const items = await client.query(
    `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN status='ATIVO'
              THEN unit_price * quantity
              ELSE 0
            END
          ),
          0
        ) AS subtotal

      FROM order_items

      WHERE order_id = $1
    `,
    [orderId]
  );

  const orderResult = await client.query(
    `
      SELECT
        discount,
        additions,
        service_fee

      FROM orders

      WHERE id = $1

      FOR UPDATE
    `,
    [orderId]
  );

  const order = orderResult.rows[0];

  if (!order) {
    throw new Error(
      'Comanda não encontrada.'
    );
  }

  const subtotal =
    money(items.rows[0].subtotal);

  const discount =
    money(order.discount);

  const additions =
    money(order.additions);

  const serviceFee =
    money(order.service_fee);

  const total =
    money(
      Math.max(
        0,
        subtotal -
          discount +
          additions +
          serviceFee
      )
    );

  awai
