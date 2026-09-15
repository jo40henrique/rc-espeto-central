import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { pool } from './db.js';
import {
  auth,
  roles,
  comparePassword,
  hashPassword,
  sign
} from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;

const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const id = () => crypto.randomUUID();

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = v => Math.round(num(v) * 100) / 100;

const fail = (res, status, error) =>
  res.status(status).json({ error });

const change = () => io.emit('state:changed');

async function audit(
  actorId,
  action,
  entity,
  entityId = null,
  tableNumber = null,
  before = null,
  after = null,
  client = pool
) {
  try {
    await client.query(
      `INSERT INTO audit_logs
       (actor_id,action,entity,entity_id,table_number,before_data,after_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        actorId || null,
        action,
        entity,
        entityId,
        tableNumber,
        before,
        after
      ]
    );
  } catch (e) {
    console.error('Auditoria:', e.message);
  }
}

/* HEALTH */

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      service: 'rc-espeto-central',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('Health:', e);
    res.status(503).json({
      ok: false,
      service: 'rc-espeto-central',
      database: 'disconnected'
    });
  }
});

/* LOGIN */

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password)
      return fail(res, 400, 'Usuário e senha são obrigatórios.');

    const { rows } = await pool.query(
      `SELECT id,name,username,password_hash,role,active
       FROM users WHERE username=$1 LIMIT 1`,
      [username]
    );

    const user = rows[0];

    if (!user)
      return fail(res, 401, 'Usuário ou senha inválidos.');

    if (!user.active)
      return fail(res, 401, 'Usuário inativo.');

    if (!await comparePassword(password, user.password_hash))
      return fail(res, 401, 'Usuário ou senha inválidos.');

    res.json({
      token: sign(user),
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role
      }
    });
  } catch (e) {
    console.error('Login:', e);
    fail(res, 500, 'Erro ao realizar login.');
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,name,username,role,active,created_at
       FROM users WHERE id=$1 LIMIT 1`,
      [req.user.sub]
    );

    const user = rows[0];

    if (!user || !user.active)
      return fail(res, 401, 'Sessão inválida.');

    res.json(user);
  } catch (e) {
    console.error('ME:', e);
    fail(res, 500, 'Erro ao verificar sessão.');
  }
});

/* MESAS */

app.get('/api/tables', auth, async (req, res) => {
  try {
    const params = [];
    let filter = '';

    if (req.user.role === 'GARCOM') {
      params.push(req.user.sub);
      filter = `AND (o.waiter_id=$1 OR o.id IS NULL)`;
    }

    const { rows } = await pool.query(
      `SELECT
         t.id,t.number,t.status,
         o.id AS order_id,o.waiter_id,o.subtotal,o.total,
         u.name AS waiter,
         COALESCE(
           (SELECT SUM(p.amount)
            FROM payments p
            WHERE p.order_id=o.id),0
         ) AS paid
       FROM dining_tables t
       LEFT JOIN LATERAL (
         SELECT *
         FROM orders ox
         WHERE ox.table_id=t.id
           AND ox.status='ABERTO'
         ORDER BY ox.opened_at DESC
         LIMIT 1
       ) o ON true
       LEFT JOIN users u ON u.id=o.waiter_id
       WHERE t.active=true ${filter}
       ORDER BY t.number`,
      params
    );

    res.json(rows.map(r => {
      const total = num(r.total);
      const paid = num(r.paid);

      return {
        ...r,
        subtotal: num(r.subtotal),
        total,
        paid,
        remaining: money(Math.max(0, total - paid))
      };
    }));
  } catch (e) {
    console.error('Mesas:', e);
    fail(res, 500, 'Erro ao carregar mesas.');
  }
});

/* ABRIR MESA */

app.post('/api/tables/:id/open', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM dining_tables
       WHERE id=$1 AND active=true
       FOR UPDATE`,
      [req.params.id]
    );

    const table = rows[0];

    if (!table) throw new Error('Mesa não encontrada.');
    if (table.status !== 'LIVRE')
      throw new Error('A mesa não está livre.');

    let waiterId = req.user.sub;

    if (req.user.role !== 'GARCOM' && req.body?.waiter_id) {
      const waiter = await client.query(
        `SELECT id FROM users
         WHERE id=$1 AND role='GARCOM' AND active=true`,
        [req.body.waiter_id]
      );

      if (!waiter.rows[0])
        throw new Error('Garçom responsável inválido.');

      waiterId = waiter.rows[0].id;
    }

    const orderId = id();

    await client.query(
      `INSERT INTO orders(id,table_id,waiter_id,status)
       VALUES($1,$2,$3,'ABERTO')`,
      [orderId, table.id, waiterId]
    );

    await client.query(
      `UPDATE dining_tables
       SET status='OCUPADA'
       WHERE id=$1`,
      [table.id]
    );

    await audit(
      req.user.sub,
      'ABRIR_MESA',
      'orders',
      orderId,
      table.number,
      null,
      { table_id: table.id, waiter_id: waiterId },
      client
    );

    await client.query('COMMIT');
    change();

    res.status(201).json({
      id: orderId,
      table_id: table.id,
      waiter_id: waiterId
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Abrir mesa:', e);
    fail(res, 400, e.message);
  } finally {
    client.release();
  }
});

/* COMANDA COMPLETA */

async function getCompleteOrder(orderId) {
  const orderQuery = await pool.query(
    `SELECT o.*,t.number AS table_number,u.name AS waiter
     FROM orders o
     JOIN dining_tables t ON t.id=o.table_id
     LEFT JOIN users u ON u.id=o.waiter_id
     WHERE o.id=$1`,
    [orderId]
  );

  const order = orderQuery.rows[0];

  if (!order) return null;

  const items = await pool.query(
    `SELECT id,product_id,product_name,unit_price,
            quantity,status,created_at
     FROM order_items
     WHERE order_id=$1
     ORDER BY created_at,id`,
    [orderId]
  );

  const payments = await pool.query(
    `SELECT p.id,p.method,p.amount,p.created_at,
            u.name AS created_by_name
     FROM payments p
     LEFT JOIN users u ON u.id=p.created_by
     WHERE p.order_id=$1
     ORDER BY p.created_at,p.id`,
    [orderId]
  );

  const paid = money(
    payments.rows.reduce((s, p) => s + num(p.amount), 0)
  );

  const total = money(order.total);

  return {
    ...order,
    subtotal: num(order.subtotal),
    discount: num(order.discount),
    additions: num(order.additions),
    service_fee: num(order.service_fee),
    total,

    items: items.rows.map(i => ({
      ...i,
      unit_price: num(i.unit_price),
      quantity: num(i.quantity)
    })),

    payments: payments.rows.map(p => ({
      ...p,
      amount: num(p.amount)
    })),

    paid,
    remaining: money(Math.max(0, total - paid))
  };
}

app.get('/api/tables/:id/order', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM orders
       WHERE table_id=$1 AND status='ABERTO'
       ORDER BY opened_at DESC
       LIMIT 1`,
      [req.params.id]
    );

    const orderId = rows[0]?.id;

    if (!orderId)
      return fail(res, 404, 'Comanda aberta não encontrada.');

    const order = await getCompleteOrder(orderId);

    if (
      req.user.role === 'GARCOM' &&
      order.waiter_id !== req.user.sub
    ) {
      return fail(res, 403, 'Essa mesa pertence a outro garçom.');
    }

    res.json(order);
  } catch (e) {
    console.error('Comanda:', e);
    fail(res, 500, 'Erro ao carregar comanda.');
  }
});

app.get('/api/orders/:id', auth, async (req, res) => {
  try {
    const order = await getCompleteOrder(req.params.id);

    if (!order)
      return fail(res, 404, 'Comanda não encontrada.');

    if (
      req.user.role === 'GARCOM' &&
      order.waiter_id !== req.user.sub
    ) {
      return fail(res, 403, 'Você não pode acessar essa comanda.');
    }

    res.json(order);
  } catch (e) {
    console.error('Order:', e);
    fail(res, 500, 'Erro ao carregar comanda.');
  }
});

/* PRODUTOS */

app.get('/api/products', auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id,p.category_id,p.name,p.description,
         p.price,p.active,c.name AS category
       FROM products p
       LEFT JOIN categories c ON c.id=p.category_id
       ORDER BY p.active DESC,c.name NULLS LAST,p.name`
    );

    res.json(rows.map(p => ({
      ...p,
      price: num(p.price)
    })));
  } catch (e) {
    console.error('Produtos:', e);
    fail(res, 500, 'Erro ao carregar produtos.');
  }
});

app.post('/api/products', auth, roles('ADMIN'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const price = Number(req.body?.price);
    const categoryName =
      String(req.body?.category || 'Outros').trim();

    if (!name || !Number.isFinite(price) || price < 0)
      return fail(res, 400, 'Nome e preço válidos são obrigatórios.');

    let category = await pool.query(
      `SELECT id FROM categories
       WHERE name=$1 LIMIT 1`,
      [categoryName]
    );

    if (!category.rows[0]) {
      category = await pool.query(
        `INSERT INTO categories(id,name)
         VALUES($1,$2) RETURNING id`,
        [id(), categoryName]
      );
    }

    const result = await pool.query(
      `INSERT INTO products(id,category_id,name,price)
       VALUES($1,$2,$3,$4)
       RETURNING *`,
      [id(), category.rows[0].id, name, price]
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

    change();
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('Produto:', e);
    fail(res, 400, 'Não foi possível criar o produto.');
  }
});

app.patch('/api/products/:id', auth, roles('ADMIN'), async (req, res) => {
  try {
    const oldQuery = await pool.query(
      `SELECT * FROM products WHERE id=$1`,
      [req.params.id]
    );

    const old = oldQuery.rows[0];

    if (!old)
      return fail(res, 404, 'Produto não encontrado.');

    const price =
      req.body?.price === undefined
        ? null
        : Number(req.body.price);

    const active =
      req.body?.active === undefined
        ? null
        : Boolean(req.body.active);

    const { rows } = await pool.query(
      `UPDATE products
       SET price=COALESCE($1,price),
           active=COALESCE($2,active),
           updated_at=now()
       WHERE id=$3
       RETURNING *`,
      [price, active, req.params.id]
    );

    await audit(
      req.user.sub,
      'EDITAR_PRODUTO',
      'products',
      req.params.id,
      null,
      old,
      rows[0]
    );

    change();
    res.json(rows[0]);
  } catch (e) {
    console.error('Editar produto:', e);
    fail(res, 400, 'Não foi possível editar o produto.');
  }
});

/* RECALCULAR */

async function recalculateOrder(orderId, client) {
  const items = await client.query(
    `SELECT COALESCE(
       SUM(
         CASE WHEN status='ATIVO'
         THEN unit_price*quantity ELSE 0 END
       ),0
     ) AS subtotal
     FROM order_items
     WHERE order_id=$1`,
    [orderId]
  );

  const orderQuery = await client.query(
    `SELECT discount,additions,service_fee
     FROM orders WHERE id=$1 FOR UPDATE`,
    [orderId]
  );

  const order = orderQuery.rows[0];

  if (!order)
    throw new Error('Comanda não encontrada.');

  const subtotal = money(items.rows[0].subtotal);
  const discount = money(order.discount);
  const additions = money(order.additions);
  const serviceFee = money(order.service_fee);

  const total = money(
    Math.max(
      0,
      subtotal - discount + additions + serviceFee
    )
  );

  await client.query(
    `UPDATE orders
     SET subtotal=$1,total=$2
     WHERE id=$3`,
    [subtotal, total, orderId]
  );

  return { subtotal, total };
}

/* ITENS */

app.post('/api/orders/:id/items', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const orderQuery = await client.query(
      `SELECT * FROM orders
       WHERE id=$1 AND status='ABERTO'
       FOR UPDATE`,
      [req.params.id]
    );

    const order = orderQuery.rows[0];

    if (!order)
      throw new Error('Comanda aberta não encontrada.');

    if (
      req.user.role === 'GARCOM' &&
      order.waiter_id !== req.user.sub
    ) {
      throw new Error('Você não pode alterar essa comanda.');
    }

    const productId = req.body?.product_id;
    const quantity = Number(req.body?.quantity || 1);

    if (
      !productId ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw new Error('Produto e quantidade são obrigatórios.');
    }

    const productQuery = await client.query(
      `SELECT id,name,price
       FROM products
       WHERE id=$1 AND active=true
       LIMIT 1`,
      [productId]
    );

    const product = productQuery.rows[0];

    if (!product)
      throw new Error('Produto não encontrado.');

    const itemId = id();

    await client.query(
      `INSERT INTO order_items
       (id,order_id,product_id,product_name,unit_price,quantity,status)
       VALUES($1,$2,$3,$4,$5,$6,'ATIVO')`,
      [
        itemId,
        order.id,
        product.id,
        product.name,
        product.price,
        quantity
      ]
    );

    await recalculateOrder(order.id, client);

    await audit(
      req.user.sub,
      'ADICIONAR_ITEM',
      'order_items',
      itemId,
      null,
      null,
      {
        order_id: order.id,
        product_id: product.id,
        quantity
      },
      client
    );

    await client.query('COMMIT');
    change();

    res.status(201).json(
      await getCompleteOrder(order.id)
    );
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Adicionar item:', e);
    fail(res, 400, e.message);
  } finally {
    client.release();
  }
});

app.patch('/api/orders/:orderId/items/:itemId', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT oi.*,o.waiter_id
       FROM order_items oi
       JOIN orders o ON o.id=oi.order_id
       WHERE oi.id=$1
         AND oi.order_id=$2
         AND o.status='ABERTO'
       FOR UPDATE`,
      [req.params.itemId, req.params.orderId]
    );

    const item = result.rows[0];

    if (!item)
      throw new Error('Item não encontrado.');

    if (
      req.user.role === 'GARCOM' &&
      item.waiter_id !== req.user.sub
    ) {
      throw new Error('Você não pode alterar essa comanda.');
    }

    const quantity = Number(req.body?.quantity);

    if (!Number.isFinite(quantity) || quantity <= 0)
      throw new Error('Quantidade inválida.');

    await client.query(
      `UPDATE order_items
       SET quantity=$1
       WHERE id=$2`,
      [quantity, item.id]
    );

    await recalculateOrder(req.params.orderId, client);

    await client.query('COMMIT');
    change();

    res.json(
      await getCompleteOrder(req.params.orderId)
    );
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Alterar item:', e);
    fail(res, 400, e.message);
  } finally {
    client.release();
  }
});

app.delete('/api/orders/:orderId/items/:itemId', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT oi.*,o.waiter_id
       FROM order_items oi
       JOIN orders o ON o.id=oi.order_id
       WHERE oi.id=$1
         AND oi.order_id=$2
         AND o.status='ABERTO'
       FOR UPDATE`,
      [req.params.itemId, req.params.orderId]
    );

    const item = result.rows[0];

    if (!item)
      throw new Error('Item não encontrado.');

    if (
      req.user.role === 'GARCOM' &&
      item.waiter_id !== req.user.sub
    ) {
      throw new Error('Você não pode alterar essa comanda.');
    }

    await client.query(
      `UPDATE order_items
       SET status='CANCELADO'
       WHERE id=$1`,
      [item.id]
    );

    await recalculateOrder(req.params.orderId, client);
    await client.query('COMMIT');

    change();
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Remover item:', e);
    fail(res, 400, e.message);
  } finally {
    client.release();
  }
});

/* DESCONTOS / ACRÉSCIMOS / TAXA */

app.patch('/api/orders/:id/values', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const query = await client.query(
      `SELECT * FROM orders
       WHERE id=$1 AND status='ABERTO'
       FOR UPDATE`,
      [req.params.id]
    );

    const order = query.rows[0];

    if (!order)
      throw new Error('Comanda aberta não encontrada.');

    if (
      req.user.role === 'GARCOM' &&
      order.waiter_id !== req.user.sub
    ) {
      throw new Error('Você não pode alterar essa comanda.');
    }

    const discount =
      req.body?.discount === undefined
        ? num(order.discount)
        : money(req.body.discount);

    const additions =
      req.body?.additions === undefined
        ? num(order.additions)
        : money(req.body.additions);

    const serviceFee =
      req.body?.service_fee === undefined
        ? num(order.service_fee)
        : money(req.body.service_fee);

    if (discount < 0 || additions < 0 || serviceFee < 0)
      throw new Error('Valores não podem ser negativos.');

    await client.query(
      `UPDATE orders
       SET discount=$1,
           additions=$2,
           service_fee=$3
       WHERE id=$4`,
      [
        discount,
        additions,
        serviceFee,
        order.id
      ]
    );

    await recalculateOrder(order.id, client);
    await client.query('COMMIT');

    change();
    res.json(await getCompleteOrder(order.id));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Valores:', e);
    fail(res, 400, e.message);
  } finally {
    client.release();
  }
});

/* PAGAMENTOS */

app.post('/api/orders/:id/payments', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const orderQuery = await client.query(
      `SELECT * FROM orders
       WHERE id=$1 AND status='ABERTO'
       FOR UPDATE`,
      [req.params.id]
    );

    const order = orderQuery.rows[0];

    if (!order)
      throw new Error('Comanda aberta não encontrada.');

    if (
      req.user.role === 'GARCOM' &&
      order.waiter_id !== req.user.sub
    ) {
      throw new Error('Você não pode receber essa comanda.');
    }

    const amount = money(req.body?.amount);
    const method =
      String(req.body?.method || '').trim().toUpperCase();

    if (!method || amount <= 0)
      throw new Error(
        'Forma de pagamento e valor são obrigatórios.'
      );

    const paidQuery = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS paid
       FROM payments
       WHERE order_id=$1`,
      [order.id]
    );

    const paid = money(paidQuery.rows[0].paid);
    const remaining = money(
      Math.max(0, num(order.total) - paid)
    );

    if (amount > remaining + 0.01) {
      throw new Error(
        `O valor excede o saldo da comanda. Restante: R$ ${remaining.toFixed(2)}`
      );
    }

    const paymentId = id();

    await client.query(
      `INSERT INTO payments
       (id,order_id,method,amount,created_by)
       VALUES($1,$2,$3,$4,$5)`,
      [
        paymentId,
        order.id,
        method,
        amount,
        req.user.sub
      ]
    );

    const newPaid = money(paid + amount);
    const newRemaining = money(
      Math.max(0, num(order.total) - newPaid)
    );

    if (newRemaining <= 0.01) {
      await client.query(
        `UPDATE orders
         SET status='FECHADO',closed_at=now()
         WHERE id=$1`,
        [order.id]
      );

      await client.query(
        `UPDATE dining_tables
         SET status='LIVRE'
         WHERE id=$1`,
        [order.table_id]
      );
    }

    await audit(
      req.user.sub,
      'RECEBER_PAGAMENTO',
      'payments',
      paymentId,
      null,
      null,
      {
        order_id: order.id,
        method,
        amount
      },
      client
    );

    await client.query('COMMIT');
    change();

    res.status(201).json(
      await getCompleteOrder(order.id)
    );
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Pagamento:', e);
    fail(res, 400, e.message);
  } finally {
    client.release();
  }
});

/* ESTORNAR PAGAMENTO */

app.delete('/api/orders/:orderId/payments/:paymentId',
  auth,
  roles('ADMIN', 'CAIXA'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const query = await client.query(
        `SELECT p.*,o.table_id,o.status
         FROM payments p
         JOIN orders o ON o.id=p.order_id
         WHERE p.id=$1 AND p.order_id=$2
         FOR UPDATE`,
        [
          req.params.paymentId,
          req.params.orderId
        ]
      );

      const payment = query.rows[0];

      if (!payment)
        throw new Error('Pagamento não encontrado.');

      await client.query(
        `DELETE FROM payments WHERE id=$1`,
        [payment.id]
      );

      if (payment.status === 'FECHADO') {
        await client.query(
          `UPDATE orders
           SET status='ABERTO',closed_at=NULL
           WHERE id=$1`,
          [req.params.orderId]
        );

        await client.query(
          `UPDATE dining_tables
           SET status='OCUPADA'
           WHERE id=$1`,
          [payment.table_id]
        );
      }

      await audit(
        req.user.sub,
        'ESTORNAR_PAGAMENTO',
        'payments',
        payment.id,
        null,
        payment,
        null,
        client
      );

      await client.query('COMMIT');
      change();

      res.json(
        await getCompleteOrder(req.params.orderId)
      );
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Estorno:', e);
      fail(res, 400, e.message);
    } finally {
      client.release();
    }
  }
);

/* USUÁRIOS */

app.get('/api/users',
  auth,
  roles('ADMIN', 'CAIXA'),
  async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id,name,username,role,active,created_at
         FROM users ORDER BY name`
      );

      res.json(rows);
    } catch (e) {
      console.error('Usuários:', e);
      fail(res, 500, 'Erro ao carregar usuários.');
    }
  }
);

app.post('/api/users',
  auth,
  roles('ADMIN'),
  async (req, res) => {
    try {
      const { name, username, password, role } =
        req.body || {};

      if (
        !name ||
        !username ||
        !password ||
        !['ADMIN', 'CAIXA', 'GARCOM'].includes(role)
      ) {
        return fail(res, 400, 'Dados de usuário inválidos.');
      }

      const passwordHash =
        await hashPassword(password);

      const { rows } = await pool.query(
        `INSERT INTO users
         (id,name,username,password_hash,role)
         VALUES($1,$2,$3,$4,$5)
         RETURNING id,name,username,role,active`,
        [
          id(),
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
        rows[0].id,
        null,
        null,
        rows[0]
      );

      change();
      res.status(201).json(rows[0]);
    } catch (e) {
      console.error('Usuário:', e);
      fail(res, 400, 'Não foi possível criar o usuário.');
    }
  }
);

app.patch('/api/users/:id',
  auth,
  roles('ADMIN'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE users
         SET active=$1,updated_at=now()
         WHERE id=$2
         RETURNING id,name,username,role,active`,
        [
          Boolean(req.body?.active),
          req.params.id
        ]
      );

      if (!rows[0])
        return fail(res, 404, 'Usuário não encontrado.');

      change();
      res.json(rows[0]);
    } catch (e) {
      console.error('Alterar usuário:', e);
      fail(res, 400, 'Não foi possível alterar o usuário.');
    }
  }
);

/* HISTÓRICO */

app.get('/api/orders/history',
  auth,
  roles('ADMIN', 'CAIXA'),
  async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           o.id,o.status,o.subtotal,o.discount,
           o.additions,o.service_fee,o.total,
           o.opened_at,o.closed_at,
           t.number AS table_number,
           u.name AS waiter
         FROM orders o
         JOIN dining_tables t ON t.id=o.table_id
         LEFT JOIN users u ON u.id=o.waiter_id
         ORDER BY COALESCE(o.closed_at,o.opened_at) DESC`
      );

      res.json(rows.map(r => ({
        ...r,
        subtotal: num(r.subtotal),
        discount: num(r.discount),
        additions: num(r.additions),
        service_fee: num(r.service_fee),
        total: num(r.total)
      })));
    } catch (e) {
      console.error('Histórico:', e);
      fail(res, 500, 'Erro ao carregar histórico.');
    }
  }
);

/* AUDITORIA */

app.get('/api/audit',
  auth,
  roles('ADMIN'),
  async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           a.*,
           u.name AS actor_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id=a.actor_id
         ORDER BY a.created_at DESC
         LIMIT 500`
      );

      res.json(rows);
    } catch (e) {
      console.error('Auditoria:', e);
      fail(res, 500, 'Erro ao carregar auditoria.');
    }
  }
);

/* FRONTEND */

app.use(express.static(PUBLIC));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'Rota da API não encontrada.'
  });
});

app.use((error, _req, res, _next) => {
  console.error('Erro global:', error);
  res.status(500).json({
    error: 'Erro interno do servidor.'
  });
});

/* SOCKET.IO */

io.on('connection', socket => {
  console.log(`Socket conectado: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`Socket desconectado: ${socket.id}`);
  });
});

/* INICIALIZAÇÃO */

async function start() {
  try {
    await pool.query('SELECT 1');

    console.log('PostgreSQL conectado.');

    server.listen(PORT, '0.0.0.0', () => {
      console.log(
        `RC Espetinho Central rodando na porta ${PORT}`
      );
    });
  } catch (e) {
    console.error(
      'Não foi possível iniciar o servidor.'
    );
    console.error(e);
    process.exit(1);
  }
}

start();

/* ENCERRAMENTO */

async function shutdown(signal) {
  console.log(`Recebido ${signal}. Encerrando...`);

  server.close(async () => {
    try {
      await pool.end();
      console.log('Servidor encerrado.');
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
