import crypto from 'node:crypto';
import { db } from '../db.js';

const SESSAO_HORAS = 12;

/* Senhas com scrypt (nativo do Node, sem dependência externa). */
export function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(senha, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function conferirSenha(senha, guardado) {
  try {
    const [alg, N, r, p, salt, key] = guardado.split('$');
    if (alg !== 'scrypt') return false;
    const esperado = Buffer.from(key, 'base64');
    const obtido = crypto.scryptSync(senha, Buffer.from(salt, 'base64'), esperado.length,
                                     { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(esperado, obtido);
  } catch { return false; }
}

export function criarSessao(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + SESSAO_HORAS * 3600e3).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, exp);
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  return { token, expiresAt: exp };
}

export function encerrarSessao(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function lerCookie(req, nome) {
  const raw = req.headers.cookie || '';
  for (const parte of raw.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Exige sessão válida. Também barra CSRF em métodos que alteram estado. */
export function exigirAdmin(req, res, next) {
  const token = lerCookie(req, 'sid');
  if (!token) return res.status(401).json({ error: 'nao_autenticado' });

  const s = db.prepare(`SELECT s.token, s.expires_at, u.id AS user_id, u.tenant_id, u.role, u.email
                        FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.token = ?`).get(token);
  if (!s || new Date(s.expires_at) < new Date()) {
    encerrarSessao(token);
    return res.status(401).json({ error: 'sessao_expirada' });
  }
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Requested-With') !== 'agenda-admin') {
    return res.status(403).json({ error: 'csrf' });
  }
  req.auth = s;
  req.sessionToken = token;
  next();
}

export function cookieSessao(token, expiresAt) {
  const seguro = String(process.env.SECURE_COOKIES ?? 'true') !== 'false';
  return `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ` +
         `Expires=${new Date(expiresAt).toUTCString()}` + (seguro ? '; Secure' : '');
}

export const cookieLimpo = () =>
  'sid=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
