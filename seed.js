import crypto from 'node:crypto'; import {pool} from './db.js'; import {hashPassword} from './auth.js';
const id=()=>crypto.randomUUID();
const admin=await hashPassword('Admin@123'); const caixa=await hashPassword('Caixa@123'); const gar=await hashPassword('Garcom@123');
await pool.query(`INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Administrador','admin',$2,'ADMIN'),($3,'Caixa','caixa',$4,'CAIXA'),($5,'Garçom Demonstração','garcom',$6,'GARCOM') ON CONFLICT(username) DO NOTHING`,[id(),admin,id(),caixa,id(),gar]);
for(let i=1;i<=20;i++) await pool.query(`INSERT INTO dining_tables(id,number) VALUES($1,$2) ON CONFLICT(number) DO NOTHING`,[id(),i]);
for(const n of ['Espetinhos','Jantinhas','Bebidas','Porções','Sobremesas','Outros']) await pool.query(`INSERT INTO categories(id,name) VALUES($1,$2) ON CONFLICT(name) DO NOTHING`,[id(),n]);
console.log('Seed concluído. Usuários: admin/Admin@123, caixa/Caixa@123, garcom/Garcom@123'); await pool.end();
