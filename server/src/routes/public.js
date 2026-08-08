import express from 'express';
import crypto from 'node:crypto';
import { db, tenantBySlug, activeService, getSettings } from '../db.js';
import { slotsForRange, slotsForDate } from '../lib/schedule.js';
import { validarAgendamento } from '../lib/validate.js';
import { parseLocal, todayLocal, addDaysStr, isValidDateStr, formatBR } from '../lib/time.js';
import { middlewareLimite, ipDe } from '../lib/ratelimit.js';

export const publicRouter = express.Router();

function carregarTenant(req, res, next) {
  const t = tenantBySlug(req.params.slug);
  if (!t) return res.status(404).json({ error: 'profissional_nao_encontrada' });
  const s = activeService(t.id);
  if (!s) return res.status(503).json({ error: 'agenda_indisponivel' });
  req.tenant = t;
  req.service = s;
  req.settings = getSettings(t.id);
  next();
}

const janelas = (tenantId) =>
  db.prepare('SELECT * FROM availability WHERE tenant_id = ? AND active = 1').all(tenantId);

const bloqueios = (tenantId, deIso, ateIso) =>
  db.prepare(`SELECT starts_at, ends_at FROM blocked_periods
              WHERE tenant_id = ? AND ends_at > ? AND starts_at < ?`).all(tenantId, deIso, ateIso);

const ocupados = (tenantId, deIso, ateIso) =>
  db.prepare(`SELECT starts_at, ends_at FROM appointments
              WHERE tenant_id = ? AND status IN ('pending','confirmed','completed','no_show')
                AND ends_at > ? AND starts_at < ?`).all(tenantId, deIso, ateIso);

/* Dados públicos mínimos para o modal se configurar sozinho. */
publicRouter.get('/:slug/config', carregarTenant, (req, res) => {
  res.json({
    name: req.tenant.name,
    timezone: req.tenant.timezone,
    whatsapp: req.tenant.whatsapp,
    service: {
      name: req.service.name,
      durationMin: req.service.duration_min,
      modalities: JSON.parse(req.service.modalities)
    },
    minNoticeHours: Number(req.settings.min_notice_hours),
    maxAdvanceDays: Number(req.settings.max_advance_days),
    today: todayLocal(req.tenant.timezone)
  });
});

/* Horários livres de um intervalo (máx. 62 dias por chamada). */
publicRouter.get('/:slug/availability', carregarTenant, (req, res) => {
  const tz = req.tenant.timezone;
  const hoje = todayLocal(tz);
  let from = String(req.query.from || hoje);
  let to = String(req.query.to || addDaysStr(from, 31));
  if (!isValidDateStr(from) || !isValidDateStr(to)) return res.status(400).json({ error: 'datas_invalidas' });
  if (from < hoje) from = hoje;
  if (to > addDaysStr(hoje, Number(req.settings.max_advance_days))) {
    to = addDaysStr(hoje, Number(req.settings.max_advance_days));
  }
  if (to > addDaysStr(from, 62)) to = addDaysStr(from, 62);
  if (to < from) return res.json({ days: {}, from, to });

  const modality = String(req.query.modality || '');
  const mods = JSON.parse(req.service.modalities);
  if (!mods.includes(modality)) return res.status(400).json({ error: 'modalidade_invalida' });

  const deIso = parseLocal(from, '00:00', tz).toISOString();
  const ateIso = parseLocal(addDaysStr(to, 1), '00:00', tz).toISOString();

  res.json({
    from, to, timezone: tz,
    days: slotsForRange({
      from, to, modality, timezone: tz,
      service: req.service,
      availability: janelas(req.tenant.id),
      blocks: bloqueios(req.tenant.id, deIso, ateIso),
      busy: ocupados(req.tenant.id, deIso, ateIso),
      settings: req.settings
    })
  });
});

/* Reserva. A palavra final é do banco, não do navegador. */
publicRouter.post('/:slug/appointments',
  middlewareLimite({ nome: 'agendar', max: Number(process.env.RATE_LIMIT_AGENDAR || 15), janelaMs: 60 * 60e3 }),
  carregarTenant,
  (req, res) => {
    const tz = req.tenant.timezone;
    const mods = JSON.parse(req.service.modalities);
    const { ok, erros, dados } = validarAgendamento(req.body || {}, mods);
    if (!ok) return res.status(422).json({ error: 'dados_invalidos', campos: erros });

    const inicio = parseLocal(dados.date, dados.time, tz);
    const fim = new Date(+inicio + req.service.duration_min * 60e3);
    const deIso = inicio.toISOString(), ateIso = fim.toISOString();

    // Revalida a regra de agenda com dados frescos — o frontend não decide nada.
    const livre = slotsForDate({
      dateStr: dados.date, modality: dados.modality, timezone: tz,
      service: req.service,
      availability: janelas(req.tenant.id),
      blocks: bloqueios(req.tenant.id, deIso, ateIso),
      busy: ocupados(req.tenant.id, deIso, ateIso),
      settings: req.settings
    }).includes(dados.time);

    if (!livre) {
      return res.status(409).json({ error: 'horario_indisponivel',
        message: 'Esse horário acabou de ficar indisponível. Escolha outro — seus dados foram mantidos.' });
    }

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    try {
      // Transação + índice único parcial: duas reservas simultâneas, uma falha.
      const gravar = db.transaction(() =>
        db.prepare(`INSERT INTO appointments
          (tenant_id, service_id, code, starts_at, ends_at, modality, name, whatsapp, email,
           status, privacy_accepted_at, created_ip)
          VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`)
          .run(req.tenant.id, req.service.id, code, deIso, ateIso, dados.modality,
               dados.name, dados.whatsapp, dados.email, new Date().toISOString(), ipDe(req)));
      gravar();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'horario_indisponivel',
          message: 'Esse horário acabou de ser reservado por outra pessoa. Escolha outro — seus dados foram mantidos.' });
      }
      throw e;
    }

    const { data, hora } = formatBR(deIso, tz);
    res.status(201).json({
      code, status: 'pending', modality: dados.modality,
      startsAt: deIso, dataFormatada: data, horaFormatada: hora,
      durationMin: req.service.duration_min, whatsapp: req.tenant.whatsapp
    });
  });
