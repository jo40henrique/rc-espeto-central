import crypto from 'node:crypto';

import { pool } from './db.js';
import { hashPassword } from './auth.js';

function id() {
  return crypto.randomUUID();
}

async function seed() {
  try {
    console.log('======================================');
    console.log(' RC ESPETINHO CENTRAL');
    console.log(' Criando dados iniciais...');
    console.log('======================================');


    // ========================================================
    // USUÁRIOS
    // ========================================================

    const adminPassword = await hashPassword('Admin@123');
    const caixaPassword = await hashPassword('Caixa@123');
    const garcomPassword = await hashPassword('Garcom@123');

    await pool.query(
      `
      INSERT INTO users (
        id,
        name,
        username,
        password_hash,
        role,
        active
      )
      VALUES
        ($1, 'Administrador', 'admin', $2, 'ADMIN', TRUE),

        ($3, 'Caixa Principal', 'caixa', $4, 'CAIXA', TRUE),

        ($5, 'Garçom Demonstração', 'garcom', $6, 'GARCOM', TRUE)

      ON CONFLICT (username)
      DO NOTHING
      `,
      [
        id(),
        adminPassword,

        id(),
        caixaPassword,

        id(),
        garcomPassword
      ]
    );


    // ========================================================
    // MESAS
    // ========================================================

    for (let number = 1; number <= 20; number++) {
      await pool.query(
        `
        INSERT INTO dining_tables (
          id,
          number,
          status,
          active
        )
        VALUES ($1, $2, 'LIVRE', TRUE)

        ON CONFLICT (number)
        DO NOTHING
        `,
        [
          id(),
          number
        ]
      );
    }


    // ========================================================
    // CATEGORIAS
    // ========================================================

    const categories = [
      'Espetinhos',
      'Jantinhas',
      'Bebidas',
      'Porções',
      'Sobremesas',
      'Outros'
    ];

    for (const name of categories) {
      await pool.query(
        `
        INSERT INTO categories (
          id,
          name,
          active
        )
        VALUES ($1, $2, TRUE)

        ON CONFLICT (name)
        DO NOTHING
        `,
        [
          id(),
          name
        ]
      );
    }


    // ========================================================
    // PRODUTOS DE EXEMPLO
    // ========================================================
    //
    // Os produtos abaixo são apenas para testar o sistema.
    // Depois podemos cadastrar o cardápio real do RC Espetinho.
    //

    const products = [
      ['Espetinho de Carne', 'Espetinho bovino', 12.00],
      ['Espetinho de Linguiça', 'Linguiça assada', 12.00],
      ['Espetinho de Frango', 'Frango assado', 12.00],
      ['Jantinha', 'Jantinha tradicional', 12.00],
      ['Refrigerante', 'Bebida refrigerante', 6.00],
      ['Água', 'Água mineral', 3.00],
      ['Pudim', 'Pudim da casa', 6.00]
    ];

    for (const [name, description, price] of products) {
      let categoryName = 'Outros';

      if (
        name.toLowerCase().includes('espetinho')
      ) {
        categoryName = 'Espetinhos';
      }

      if (
        name.toLowerCase().includes('jantinha')
      ) {
        categoryName = 'Jantinhas';
      }

      if (
        name === 'Refrigerante' ||
        name === 'Água'
      ) {
        categoryName = 'Bebidas';
      }

      if (
        name === 'Pudim'
      ) {
        categoryName = 'Sobremesas';
      }

      const categoryResult = await pool.query(
        `
        SELECT id
        FROM categories
        WHERE name = $1
        LIMIT 1
        `,
        [categoryName]
      );

      const categoryId = categoryResult.rows[0]?.id;

      await pool.query(
        `
        INSERT INTO products (
          id,
          category_id,
          name,
          description,
          price,
          active
        )
        SELECT
          $1,
          $2,
          $3,
          $4,
          $5,
          TRUE

        WHERE NOT EXISTS (
          SELECT 1
          FROM products
          WHERE name = $3
        )
        `,
        [
          id(),
          categoryId,
          name,
          description,
          price
        ]
      );
    }


    console.log('');
    console.log('======================================');
    console.log(' SEED CONCLUÍDO COM SUCESSO');
    console.log('======================================');
    console.log('');
    console.log('Usuários iniciais:');
    console.log('');
    console.log('ADMIN');
    console.log('Usuário: admin');
    console.log('Senha:   Admin@123');
    console.log('');
    console.log('CAIXA');
    console.log('Usuário: caixa');
    console.log('Senha:   Caixa@123');
    console.log('');
    console.log('GARÇOM');
    console.log('Usuário: garcom');
    console.log('Senha:   Garcom@123');
    console.log('');
    console.log('20 mesas foram preparadas.');
    console.log('Categorias foram preparadas.');
    console.log('Produtos de teste foram preparados.');
    console.log('======================================');

  } catch (error) {
    console.error('');
    console.error('ERRO durante o seed:');
    console.error(error);
    console.error('');

    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await seed();
