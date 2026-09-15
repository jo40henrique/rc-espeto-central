import jwt from 'jsonwebtoken'; import bcrypt from 'bcryptjs'; import dotenv from 'dotenv'; dotenv.config();
export const hashPassword=p=>bcrypt.hash(p,12); export const comparePassword=(p,h)=>bcrypt.compare(p,h);
export function sign(user){return jwt.sign({sub:user.id,name:user.name,role:user.role},process.env.JWT_SECRET,{expiresIn:'12h'});}
export function auth(req,res,next){const h=req.headers.authorization||'';try{if(!h.startsWith('Bearer '))throw 0;req.user=jwt.verify(h.slice(7),process.env.JWT_SECRET);next()}catch{res.status(401).json({error:'Sessão inválida ou expirada.'})}}
export const roles=(...rs)=>(req,res,next)=>rs.includes(req.user.role)?next():res.status(403).json({error:'Acesso não autorizado.'});
