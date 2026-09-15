import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

/*
 * Conexão com o PostgreSQL.
 *
 * No Railway, a variável DATABASE_URL deve ser
 * configurada nas Variables do serviço.
 */
if (!process.env.DATABASE_URL) {
  console.error('ERRO: DATABASE_URL não foi configurada.');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // O PostgreSQL do Railway normalmente utiliza SSL.
  ssl: process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,

  // Limites seguros para a aplicação.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});


/*
 * Testa a conexão com o banco.
 */
pool.on('error', (error) => {
  console.error('Erro inesperado no PostgreSQL:', error);
});


/*
 * Executa uma função dentro de uma transação.
 *
 * Se tudo der certo:
 *   BEGIN → operações → COMMIT
 *
 * Se ocorrer erro:
 *   BEGIN → operações → ROLLBACK
 */
export async function tx(callback) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await callback(client);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Erro ao executar ROLLBACK:', rollbackError);
    }

    throw error;
  } finally {
    client.release();
  }
}


/*
 * Teste manual da conexão.
 *
 * Pode ser usado pelo servidor para verificar
 * rapidamente se o banco está funcionando.
 */
export async function testDatabaseConnection() {
  const result = await pool.query(`
    SELECT
      NOW() AS current_time
  `);

  return result.rows[0];
}
