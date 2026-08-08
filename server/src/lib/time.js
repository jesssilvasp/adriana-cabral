/* Conversões entre hora local da profissional (IANA timezone) e UTC.
   Sem dependências: usa Intl. Funciona com qualquer fuso, inclusive
   os que têm horário de verão. */

function offsetMs(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day,
                         p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** Hora de parede no fuso da profissional -> instante UTC. */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = guess - offsetMs(new Date(guess), tz);
  ts = guess - offsetMs(new Date(ts), tz);          // refina em bordas de DST
  return new Date(ts);
}

/** '2026-08-12' + '14:30' -> Date UTC */
export function parseLocal(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return zonedToUtc(y, m, d, hh, mm, tz);
}

/** Instante -> partes no fuso da profissional. */
export function zonedParts(date, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`,
    weekday: wd
  };
}

/** 'YYYY-MM-DD' de hoje no fuso da profissional. */
export function todayLocal(tz, now = new Date()) {
  return zonedParts(now, tz).date;
}

export function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const toHHMM = (min) =>
  String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

export function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTimeStr(s) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(s);
}

/** Formatação amigável em pt-BR, no fuso da profissional. */
export function formatBR(isoUtc, tz) {
  const d = new Date(isoUtc);
  const data = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  }).format(d);
  const hora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz, hour: '2-digit', minute: '2-digit'
  }).format(d);
  return { data, hora };
}
