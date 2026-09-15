import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('ERRO: JWT_SECRET não foi configurado.');
  process.exit(1);
}


/*
 * Criptografa uma senha.
 */
export async function hashPassword(password) {
  if (!password) {
    throw new Error('Senha não informada.');
  }

  return bcrypt.hash(password, 12);
}


/*
 * Compara uma senha digitada com a senha
 * criptografada armazenada no banco.
 */
export async function comparePassword(password, passwordHash) {
  if (!password || !passwordHash) {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
}


/*
 * Cria o token de autenticação do usuário.
 *
 * O token contém apenas informações necessárias
 * para identificar o usuário e suas permissões.
 */
export function sign(user) {
  return jwt.sign(
    {
      sub: user.id,
      name: user.name,
      role: user.role
    },
    JWT_SECRET,
    {
      expiresIn: '12h'
    }
  );
}


/*
 * Middleware de autenticação.
 *
 * Verifica se existe:
 *
 * Authorization: Bearer TOKEN
 */
export function auth(req, res, next) {
  const authorization = req.headers.authorization || '';

  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Sessão não informada.'
    });
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      error: 'Token não informado.'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Sessão inválida ou expirada.'
    });
  }
}


/*
 * Middleware para controlar permissões.
 *
 * Exemplo:
 *
 * roles('ADMIN', 'CAIXA')
 *
 * significa que somente ADMIN ou CAIXA
 * poderão acessar determinada rota.
 */
export function roles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Usuário não autenticado.'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Acesso não autorizado.'
      });
    }

    next();
  };
}
