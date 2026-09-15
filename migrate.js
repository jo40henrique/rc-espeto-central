import fs from 'node:fs/promises'; import {pool} from './db.js';
await pool.query(await fs.readFile(new URL('../db/schema.sql',import.meta.url),'utf8')); console.log('Banco preparado.'); await pool.end();
