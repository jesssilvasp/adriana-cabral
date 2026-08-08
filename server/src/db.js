import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/agenda.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/* ------------------------------------------------------------------
   Banco: SQLite embutido no próprio Node (`node:sqlite`).

   Nada é compilado e nada é baixado — por isso o projeto não precisa
   de Python nem das ferramentas de build do Visual Studio. Funciona a
   partir do Node 22.5; no Node 24+ o módulo já é estável.

   Quem estiver preso a um Node antigo pode instalar o driver
   alternativo com `npm i better-sqlite3` — o código detecta sozinho.
   ------------------------------------------------------------------ */
async function abrirBanco() {
  let raw = null;

  try {
    const { DatabaseSync } = await import('node:sqlite');
    raw = new DatabaseSync(DB_PATH);
    raw.motor = 'node:sqlite';
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('PRAGMA busy_timeout = 5000');
    // better-sqlite3 tem .transaction(); aqui replicamos o mesmo contrato.
    raw.transaction = (fn) => (...args) => {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = fn(...args); raw.exec('COMMIT'); return r; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
    };
    return raw;
  } catch (e) {
    if (!['ERR_UNKNOWN_BUILTIN_MODULE', 'ERR_MODULE_NOT_FOUND'].includes(e.code)) throw e;
  }

  try {
    const { default: Database } = await import('better-sqlite3');
    raw = new Database(DB_PATH);
    raw.motor = 'better-sqlite3';
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');
    return raw;
  } catch {
    const v = process.versions.node;
    throw new Error(
      '\n\n  Não foi possível abrir o banco de dados.\n\n' +
      `  Seu Node é a versão ${v}. Este projeto usa o SQLite que já vem\n` +
      '  embutido no Node a partir da versão 22.5.\n\n' +
      '  Como resolver (escolha um):\n' +
      '    1. Instale o Node 24 em https://nodejs.org  (recomendado)\n' +
      '    2. Ou rode:  npm i better-sqlite3   (exige ferramentas de compilação)\n');
  }
}

export const db = await abrirBanco();

/* ------------------------------------------------------------------
   Esquema. `tenants` isola a identidade de cada profissional, para que
   o mesmo módulo sirva outras landing pages sem duplicar código.
   Todos os instantes são gravados em UTC (ISO 8601, sufixo Z).
   ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  whatsapp    TEXT,
  site_url    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  duration_min  INTEGER NOT NULL CHECK (duration_min > 0),
  buffer_min    INTEGER NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
  modalities    TEXT NOT NULL DEFAULT '["online","presencial"]',
  active        INTEGER NOT NULL DEFAULT 1
);

-- Janelas de atendimento por dia da semana (0 = domingo).
CREATE TABLE IF NOT EXISTS availability (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TEXT NOT NULL,   -- 'HH:MM' no fuso da profissional
  end_time    TEXT NOT NULL,
  modality    TEXT,            -- NULL = vale para todas as modalidades
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_availability_tenant ON availability(tenant_id, weekday, active);

-- Férias, feriados, compromissos pessoais.
CREATE TABLE IF NOT EXISTS blocked_periods (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  starts_at   TEXT NOT NULL,   -- UTC ISO
  ends_at     TEXT NOT NULL,   -- UTC ISO
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_blocks_range ON blocked_periods(tenant_id, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS appointments (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id          INTEGER NOT NULL REFERENCES services(id),
  code                TEXT NOT NULL UNIQUE,
  starts_at           TEXT NOT NULL,   -- UTC ISO
  ends_at             TEXT NOT NULL,   -- UTC ISO
  modality            TEXT NOT NULL CHECK (modality IN ('online','presencial')),
  name                TEXT NOT NULL,
  whatsapp            TEXT NOT NULL,
  email               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed','completed','cancelled','no_show')),
  privacy_accepted_at TEXT NOT NULL,
  created_ip          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- TRAVA ANTI-DUPLICIDADE: no banco, não no frontend.
-- Um horário só pode ter um agendamento vivo; cancelados liberam o slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_slot
  ON appointments(tenant_id, starts_at)
  WHERE status IN ('pending','confirmed','completed','no_show');

CREATE INDEX IF NOT EXISTS ix_appointments_range  ON appointments(tenant_id, starts_at);
CREATE INDEX IF NOT EXISTS ix_appointments_status ON appointments(tenant_id, status, starts_at);

CREATE TABLE IF NOT EXISTS settings (
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
`);

/* ---------------------------- helpers ---------------------------- */

export const DEFAULT_SETTINGS = {
  min_notice_hours: '12',   // antecedência mínima para reservar
  max_advance_days: '60',   // até quando é possível reservar
  slot_step_min: '0'        // 0 = usa duração + intervalo do serviço
};

export function getSettings(tenantId) {
  const rows = db.prepare('SELECT key, value FROM settings WHERE tenant_id = ?').all(tenantId);
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSetting(tenantId, key, value) {
  db.prepare(`INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
              ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`)
    .run(tenantId, key, String(value));
}

export function tenantBySlug(slug) {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
}

export function activeService(tenantId) {
  return db.prepare('SELECT * FROM services WHERE tenant_id = ? AND active = 1 ORDER BY id LIMIT 1').get(tenantId);
}
