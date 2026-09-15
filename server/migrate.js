import fs from 'node:fs/promises';
import { pool } from './db.js';

async function migrate() {
  try {
    console.log('======================================');
    console.log(' RC ESPETINHO CENTRAL');
    console.log(' Iniciando migração do banco...');
    console.log('======================================');

    const schemaPath = new URL('../db/schema.sql', import.meta.url);

    const schema = await fs.readFile(schemaPath, 'utf8');

    if (!schema.trim()) {
      throw new Error('O arquivo db/schema.sql está vazio.');
    }

    await pool.query(schema);

    console.log('Banco de dados preparado com sucesso.');
    console.log('Todas as tabelas e índices foram verificados.');
  } catch (error) {
    console.error('ERRO durante a migração do banco:');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await migrate();
