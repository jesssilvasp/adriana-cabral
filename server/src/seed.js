/* Carga inicial. Idempotente: rodar de novo não sobrescreve nada existente.
   É aqui que a identidade da cliente entra — trocar as variáveis do .env
   basta para servir outra profissional com o mesmo código. */

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

const { db, setSetting, DEFAULT_SETTINGS } = await import('./db.js');
const { hashSenha } = await import('./lib/auth.js');

const slug = process.env.TENANT_SLUG || 'profissional';
const nome = process.env.TENANT_NAME || 'Profissional';
const tz = process.env.TENANT_TIMEZONE || 'America/Sao_Paulo';
const zap = process.env.TENANT_WHATSAPP || '';
const site = process.env.TENANT_SITE || '';
const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const senha = process.env.ADMIN_PASSWORD || '';

if (!email || senha.length < 10) {
  console.error('Defina ADMIN_EMAIL e ADMIN_PASSWORD (mínimo 10 caracteres) no .env');
  process.exit(1);
}

let t = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
if (!t) {
  db.prepare('INSERT INTO tenants (slug, name, timezone, whatsapp, site_url) VALUES (?,?,?,?,?)')
    .run(slug, nome, tz, zap, site);
  t = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  console.log('tenant criado:', slug);
} else {
  db.prepare('UPDATE tenants SET name = ?, timezone = ?, whatsapp = ?, site_url = ? WHERE id = ?')
    .run(nome, tz, zap, site, t.id);
  console.log('tenant atualizado:', slug);
}

const usuario = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND email = ?').get(t.id, email);
if (!usuario) {
  db.prepare('INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?,?,?,?)')
    .run(t.id, email, hashSenha(senha), 'owner');
  console.log('usuária criada:', email);
} else {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSenha(senha), usuario.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(usuario.id);
  console.log('usuária atualizada:', email);
}

if (!db.prepare('SELECT 1 FROM services WHERE tenant_id = ?').get(t.id)) {
  db.prepare(`INSERT INTO services (tenant_id, name, duration_min, buffer_min, modalities)
              VALUES (?, 'Sessão de psicoterapia', 60, 0, '["online","presencial"]')`).run(t.id);
  console.log('serviço criado: 60 min');
}

if (!db.prepare('SELECT 1 FROM availability WHERE tenant_id = ?').get(t.id)) {
  // Grade inicial de exemplo — a profissional ajusta no /admin.
  const ins = db.prepare('INSERT INTO availability (tenant_id, weekday, start_time, end_time) VALUES (?,?,?,?)');
  for (const wd of [1, 2, 3, 4, 5]) {
    ins.run(t.id, wd, '09:00', '12:00');
    ins.run(t.id, wd, '14:00', '18:00');
  }
  console.log('disponibilidade inicial criada (seg–sex, 9–12 e 14–18)');
}

for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (!db.prepare('SELECT 1 FROM settings WHERE tenant_id = ? AND key = ?').get(t.id, k)) setSetting(t.id, k, v);
}

console.log('pronto. painel em /admin');
