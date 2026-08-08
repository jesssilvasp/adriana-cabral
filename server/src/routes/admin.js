import express from 'express';
import { db, getSettings, setSetting, activeService, DEFAULT_SETTINGS } from '../db.js';
import { conferirSenha, criarSessao, encerrarSessao, exigirAdmin, cookieSessao, cookieLimpo } from '../lib/auth.js';
import { validarBloqueio, validarJanela } from '../lib/validate.js';
import { parseLocal, formatBR, isValidDateStr, isValidTimeStr, todayLocal, addDaysStr } from '../lib/time.js';
import { slotsForDate } from '../lib/schedule.js';
import { middlewareLimite } from '../lib/ratelimit.js';

export const adminRouter = express.Router();

const STATUS = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];

adminRouter.post('/login',
  middlewareLimite({ nome: 'login', max: 8, janelaMs: 15 * 60e3 }),
  (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const senha = String(req.body?.password || '');
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || !conferirSenha(senha, u.password_hash)) {
      return res.status(401).json({ error: 'credenciais_invalidas' });
    }
    const { token, expiresAt } = criarSessao(u.id);
    res.set('Set-Cookie', cookieSessao(token, expiresAt));
    res.json({ ok: true, email: u.email });
  });

adminRouter.post('/logout', exigirAdmin, (req, res) => {
  encerrarSessao(req.sessionToken);
  res.set('Set-Cookie', cookieLimpo()).json({ ok: true });
});

adminRouter.get('/me', exigirAdmin, (req, res) => {
  const t = db.prepare('SELECT slug, name, timezone, whatsapp FROM tenants WHERE id = ?').get(req.auth.tenant_id);
  const s = activeService(req.auth.tenant_id);
  res.json({ email: req.auth.email, role: req.auth.role, tenant: t,
             service: s && { name: s.name, durationMin: s.duration_min, bufferMin: s.buffer_min,
                             modalities: JSON.parse(s.modalities) } });
});

/* ----------------------------- agenda ----------------------------- */

adminRouter.get('/appointments', exigirAdmin, (req, res) => {
  const t = db.prepare('SELECT timezone FROM tenants WHERE id = ?').get(req.auth.tenant_id);
  const cond = ['tenant_id = ?'];
  const args = [req.auth.tenant_id];

  if (req.query.status && STATUS.includes(String(req.query.status))) {
    cond.push('status = ?'); args.push(String(req.query.status));
  }
  if (req.query.from && isValidDateStr(String(req.query.from))) {
    cond.push('starts_at >= ?'); args.push(parseLocal(String(req.query.from), '00:00', t.timezone).toISOString());
  }
  if (req.query.to && isValidDateStr(String(req.query.to))) {
    cond.push('starts_at < ?'); args.push(parseLocal(addDaysStr(String(req.query.to), 1), '00:00', t.timezone).toISOString());
  }
  if (req.query.scope === 'proximos') {
    cond.push("starts_at >= ?"); args.push(new Date().toISOString());
    cond.push("status IN ('pending','confirmed')");
  }

  const linhas = db.prepare(
    `SELECT id, code, starts_at, ends_at, modality, name, whatsapp, email, status, created_at
     FROM appointments WHERE ${cond.join(' AND ')}
     ORDER BY starts_at ${req.query.scope === 'proximos' ? 'ASC' : 'DESC'} LIMIT 300`).all(...args);

  res.json({
    timezone: t.timezone,
    appointments: linhas.map(a => ({ ...a, ...formatBR(a.starts_at, t.timezone) }))
  });
});

adminRouter.patch('/appointments/:id', exigirAdmin, (req, res) => {
  const t = db.prepare('SELECT timezone FROM tenants WHERE id = ?').get(req.auth.tenant_id);
  const ag = db.prepare('SELECT * FROM appointments WHERE id = ? AND tenant_id = ?')
               .get(req.params.id, req.auth.tenant_id);
  if (!ag) return res.status(404).json({ error: 'nao_encontrado' });

  const { status, date, time } = req.body || {};

  // Reagendamento: mesma trava de duplicidade do fluxo público.
  if (date || time) {
    if (!isValidDateStr(String(date)) || !isValidTimeStr(String(time))) {
      return res.status(422).json({ error: 'data_ou_hora_invalida' });
    }
    const svc = activeService(req.auth.tenant_id);
    const ini = parseLocal(String(date), String(time), t.timezone);
    const fim = new Date(+ini + svc.duration_min * 60e3);
    const conflito = db.prepare(
      `SELECT 1 FROM appointments WHERE tenant_id = ? AND id != ?
         AND status IN ('pending','confirmed','completed','no_show')
         AND ends_at > ? AND starts_at < ?`)
      .get(req.auth.tenant_id, ag.id, ini.toISOString(), fim.toISOString());
    if (conflito) return res.status(409).json({ error: 'horario_ocupado' });
    try {
      db.prepare(`UPDATE appointments SET starts_at = ?, ends_at = ?, updated_at = datetime('now')
                  WHERE id = ?`).run(ini.toISOString(), fim.toISOString(), ag.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'horario_ocupado' });
      throw e;
    }
  }

  if (status) {
    if (!STATUS.includes(status)) return res.status(422).json({ error: 'status_invalido' });
    try {
      db.prepare("UPDATE appointments SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, ag.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'horario_ocupado' });
      throw e;
    }
  }

  const novo = db.prepare('SELECT * FROM appointments WHERE id = ?').get(ag.id);
  res.json({ ...novo, ...formatBR(novo.starts_at, t.timezone) });
});

/* Horários livres para reagendar, reaproveitando a mesma lógica pública. */
adminRouter.get('/slots', exigirAdmin, (req, res) => {
  const t = db.prepare('SELECT timezone FROM tenants WHERE id = ?').get(req.auth.tenant_id);
  const date = String(req.query.date || '');
  const modality = String(req.query.modality || 'online');
  if (!isValidDateStr(date)) return res.status(400).json({ error: 'data_invalida' });

  const svc = activeService(req.auth.tenant_id);
  const deIso = parseLocal(date, '00:00', t.timezone).toISOString();
  const ateIso = parseLocal(addDaysStr(date, 1), '00:00', t.timezone).toISOString();

  res.json({ slots: slotsForDate({
    dateStr: date, modality, timezone: t.timezone, service: svc,
    availability: db.prepare('SELECT * FROM availability WHERE tenant_id = ? AND active = 1').all(req.auth.tenant_id),
    blocks: db.prepare('SELECT starts_at, ends_at FROM blocked_periods WHERE tenant_id = ? AND ends_at > ? AND starts_at < ?').all(req.auth.tenant_id, deIso, ateIso),
    busy: db.prepare("SELECT starts_at, ends_at FROM appointments WHERE tenant_id = ? AND status IN ('pending','confirmed','completed','no_show') AND ends_at > ? AND starts_at < ?").all(req.auth.tenant_id, deIso, ateIso),
    settings: { ...getSettings(req.auth.tenant_id), min_notice_hours: '0' }
  }) });
});

/* --------------------------- bloqueios --------------------------- */

adminRouter.get('/blocks', exigirAdmin, (req, res) => {
  const t = db.prepare('SELECT timezone FROM tenants WHERE id = ?').get(req.auth.tenant_id);
  const linhas = db.prepare(`SELECT * FROM blocked_periods WHERE tenant_id = ? AND ends_at > datetime('now')
                             ORDER BY starts_at LIMIT 200`).all(req.auth.tenant_id);
  res.json({ blocks: linhas.map(b => ({ ...b, inicio: formatBR(b.starts_at, t.timezone), fim: formatBR(b.ends_at, t.timezone) })) });
});

adminRouter.post('/blocks', exigirAdmin, (req, res) => {
  const { ok, erros, dados } = validarBloqueio(req.body || {});
  if (!ok) return res.status(422).json({ error: 'dados_invalidos', campos: erros });
  const r = db.prepare('INSERT INTO blocked_periods (tenant_id, starts_at, ends_at, reason) VALUES (?,?,?,?)')
              .run(req.auth.tenant_id, dados.starts_at, dados.ends_at, dados.reason || null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

adminRouter.delete('/blocks/:id', exigirAdmin, (req, res) => {
  db.prepare('DELETE FROM blocked_periods WHERE id = ? AND tenant_id = ?').run(req.params.id, req.auth.tenant_id);
  res.json({ ok: true });
});

/* ------------------------ disponibilidade ------------------------ */

adminRouter.get('/availability', exigirAdmin, (req, res) => {
  res.json({ availability: db.prepare('SELECT * FROM availability WHERE tenant_id = ? ORDER BY weekday, start_time')
                             .all(req.auth.tenant_id) });
});

adminRouter.put('/availability', exigirAdmin, (req, res) => {
  const janelas = Array.isArray(req.body?.availability) ? req.body.availability : null;
  if (!janelas) return res.status(422).json({ error: 'formato_invalido' });
  if (janelas.length > 60) return res.status(422).json({ error: 'muitas_janelas' });
  for (const j of janelas) if (!validarJanela(j)) return res.status(422).json({ error: 'janela_invalida', janela: j });

  const trocar = db.transaction(() => {
    db.prepare('DELETE FROM availability WHERE tenant_id = ?').run(req.auth.tenant_id);
    const ins = db.prepare('INSERT INTO availability (tenant_id, weekday, start_time, end_time, modality, active) VALUES (?,?,?,?,?,1)');
    for (const j of janelas) ins.run(req.auth.tenant_id, j.weekday, j.start_time, j.end_time, j.modality || null);
  });
  trocar();
  res.json({ ok: true, total: janelas.length });
});

/* -------------------------- configurações -------------------------- */

adminRouter.get('/settings', exigirAdmin, (req, res) => {
  const s = activeService(req.auth.tenant_id);
  res.json({ settings: getSettings(req.auth.tenant_id),
             service: { name: s.name, durationMin: s.duration_min, bufferMin: s.buffer_min,
                        modalities: JSON.parse(s.modalities) } });
});

adminRouter.put('/settings', exigirAdmin, (req, res) => {
  const b = req.body || {};
  const num = (v, min, max) => Number.isFinite(+v) && +v >= min && +v <= max;

  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (b[k] === undefined) continue;
    if (k === 'min_notice_hours' && !num(b[k], 0, 720)) return res.status(422).json({ error: k });
    if (k === 'max_advance_days' && !num(b[k], 1, 365)) return res.status(422).json({ error: k });
    if (k === 'slot_step_min' && !num(b[k], 0, 480)) return res.status(422).json({ error: k });
    setSetting(req.auth.tenant_id, k, Math.round(+b[k]));
  }

  if (b.durationMin !== undefined || b.bufferMin !== undefined) {
    const s = activeService(req.auth.tenant_id);
    const dur = b.durationMin !== undefined ? Math.round(+b.durationMin) : s.duration_min;
    const buf = b.bufferMin !== undefined ? Math.round(+b.bufferMin) : s.buffer_min;
    if (!num(dur, 15, 480) || !num(buf, 0, 240)) return res.status(422).json({ error: 'duracao_invalida' });
    db.prepare('UPDATE services SET duration_min = ?, buffer_min = ? WHERE id = ?').run(dur, buf, s.id);
  }
  res.json({ ok: true });
});
