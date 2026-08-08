/* Lógica pura da agenda — sem Express, sem SQL.
   Recebe dados já carregados e devolve os horários realmente livres.
   Isolada de propósito: é o que outras landing pages vão reaproveitar. */

import { parseLocal, weekdayOf, toMin, toHHMM, addDaysStr, todayLocal } from './time.js';

const overlaps = (aIni, aFim, bIni, bFim) => aIni < bFim && bIni < aFim;

/**
 * Horários livres de UM dia.
 * @param {string} dateStr 'YYYY-MM-DD' no fuso da profissional
 * @returns {string[]} ex.: ['09:00','10:00']
 */
export function slotsForDate({
  dateStr, modality, timezone, service, availability,
  blocks = [], busy = [], settings, now = new Date()
}) {
  const minNoticeMs = Number(settings.min_notice_hours || 0) * 3600e3;
  const maxAdvance = Number(settings.max_advance_days || 60);

  const hoje = todayLocal(timezone, now);
  if (dateStr < hoje) return [];
  if (dateStr > addDaysStr(hoje, maxAdvance)) return [];

  const wd = weekdayOf(dateStr);
  const janelas = availability.filter(a =>
    a.active !== 0 && a.weekday === wd && (!a.modality || a.modality === modality));
  if (!janelas.length) return [];

  const dur = Number(service.duration_min);
  const buf = Number(service.buffer_min || 0);
  const passo = Number(settings.slot_step_min) > 0 ? Number(settings.slot_step_min) : dur + buf;

  const limite = now.getTime() + minNoticeMs;
  const livres = [];

  for (const j of janelas) {
    const ini = toMin(j.start_time), fim = toMin(j.end_time);
    for (let t = ini; t + dur <= fim; t += passo) {
      const hhmm = toHHMM(t);
      const sIni = parseLocal(dateStr, hhmm, timezone).getTime();
      const sFim = sIni + dur * 60e3;

      if (sIni < limite) continue;                                    // antecedência mínima
      if (blocks.some(b => overlaps(sIni, sFim, +new Date(b.starts_at), +new Date(b.ends_at)))) continue;
      if (busy.some(b => overlaps(sIni, sFim, +new Date(b.starts_at), +new Date(b.ends_at)))) continue;

      if (!livres.includes(hhmm)) livres.push(hhmm);
    }
  }
  return livres.sort();
}

/** Mapa { 'YYYY-MM-DD': ['09:00', ...] } para um intervalo de datas. */
export function slotsForRange({ from, to, ...rest }) {
  const out = {};
  let d = from;
  for (let i = 0; i < 400 && d <= to; i++) {
    const s = slotsForDate({ dateStr: d, ...rest });
    if (s.length) out[d] = s;
    d = addDaysStr(d, 1);
  }
  return out;
}

/** Revalidação usada no POST, imediatamente antes de gravar. */
export function isSlotBookable(args) {
  return slotsForDate(args).includes(args.timeStr);
}
