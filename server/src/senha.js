/* Cria ou troca o acesso ao painel /admin.
   Uso:  npm run senha -- email@dominio.com "nova senha"
   A senha nunca é gravada em texto — só o hash scrypt. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(raiz, '.env');
if (fs.existsSync(envPath)) {
  for (const linha of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { db } = await import('./db.js');
const { hashSenha } = await import('./lib/auth.js');

const remover = process.argv[2] === '--remover';
const email = (remover ? process.argv[3] : process.argv[2] || '').toLowerCase().trim();
const senha = remover ? '' : (process.argv[3] || '');

if (!email || (!remover && !senha)) {
  console.error('Uso:  npm run senha -- email@dominio.com "nova senha"');
  console.error('      npm run senha -- --remover email@antigo.com');
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
  console.error('E-mail inválido.');
  process.exit(1);
}
if (!remover && senha.length < 10) {
  console.error('A senha precisa ter pelo menos 10 caracteres.');
  process.exit(1);
}

const slug = process.env.TENANT_SLUG || 'adriana-cabral';
const t = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
if (!t) {
  console.error(`Nenhum tenant "${slug}". Rode "npm run seed" antes.`);
  process.exit(1);
}

const existente = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND email = ?').get(t.id, email);

if (remover) {
  if (!existente) { console.error(`Não existe acesso com o e-mail ${email}.`); process.exit(1); }
  const total = db.prepare('SELECT COUNT(*) c FROM users WHERE tenant_id = ?').get(t.id).c;
  if (total <= 1) { console.error('Este é o único acesso ao painel — crie outro antes de remover.'); process.exit(1); }
  db.prepare('DELETE FROM users WHERE id = ?').run(existente.id);
  console.log(`Acesso removido: ${email}`);
  process.exit(0);
}

if (existente) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSenha(senha), existente.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existente.id);   // derruba sessões abertas
  console.log(`Senha trocada para ${email}. Sessões antigas foram encerradas.`);
} else {
  const antigos = db.prepare('SELECT id, email FROM users WHERE tenant_id = ?').all(t.id);
  db.prepare('INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?,?,?,?)')
    .run(t.id, email, hashSenha(senha), 'owner');
  console.log(`Acesso criado: ${email}`);
  if (antigos.length) {
    console.log('Já existiam outros acessos: ' + antigos.map(u => u.email).join(', '));
    console.log('Para remover um deles: npm run senha -- --remover email@antigo.com');
  }
}
