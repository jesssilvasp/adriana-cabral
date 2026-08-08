/* Testes de integração — sobem o servidor real com um banco temporário.
   Rodar: npm test */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.PORT = '4321';
process.env.SECURE_COOKIES = 'false';
process.env.RATE_LIMIT_AGENDAR = '500';
process.env.TENANT_SLUG = 'teste';
process.env.TENANT_NAME = 'Profissional Teste';
process.env.TENANT_TIMEZONE = 'America/Sao_Paulo';
process.env.TENANT_WHATSAPP = '5516999999999';
process.env.ADMIN_EMAIL = 'admin@teste.local';
process.env.ADMIN_PASSWORD = 'senha-de-teste-123';

const { db, setSetting } = await import('../src/db.js');
const { hashSenha } = await import('../src/lib/auth.js');

// ---- carga mínima (equivalente ao seed, sem depender do .env) ----
db.prepare('INSERT INTO tenants (slug,name,timezone,whatsapp) VALUES (?,?,?,?)')
  .run('teste', 'Profissional Teste', 'America/Sao_Paulo', '5516999999999');
const t = db.prepare('SELECT * FROM tenants WHERE slug = ?').get('teste');
db.prepare('INSERT INTO users (tenant_id,email,password_hash) VALUES (?,?,?)')
  .run(t.id, 'admin@teste.local', hashSenha('senha-de-teste-123'));
db.prepare(`INSERT INTO services (tenant_id,name,duration_min,buffer_min,modalities)
            VALUES (?,'Sessão',60,0,'["online","presencial"]')`).run(t.id);
const insJ = db.prepare('INSERT INTO availability (tenant_id,weekday,start_time,end_time) VALUES (?,?,?,?)');
for (let wd = 0; wd <= 6; wd++) insJ.run(t.id, wd, '09:00', '18:00');   // todo dia, para o teste ser estável
setSetting(t.id, 'min_notice_hours', '0');
setSetting(t.id, 'max_advance_days', '60');
setSetting(t.id, 'slot_step_min', '0');

await import('../src/index.js');
await new Promise(r => setTimeout(r, 400));

const BASE = 'http://127.0.0.1:4321';
const j = (r) => r.json().catch(() => ({}));

const { todayLocal, addDaysStr } = await import('../src/lib/time.js');
const amanha = addDaysStr(todayLocal('America/Sao_Paulo'), 1);
const ontem = addDaysStr(todayLocal('America/Sao_Paulo'), -1);

let passou = 0, falhou = 0;
async function teste(nome, fn) {
  try { await fn(); console.log('  ok   ' + nome); passou++; }
  catch (e) { console.log('  FALHA ' + nome + '\n        ' + e.message); falhou++; }
}

const agendar = (corpo) => fetch(`${BASE}/api/teste/appointments`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo)
});

const base = (extra = {}) => ({
  modality: 'online', date: amanha, time: '10:00',
  name: 'Maria Teste', whatsapp: '16999998888', email: 'maria@exemplo.com',
  privacy: true, ...extra
});

console.log('\nagendamento público');

await teste('config pública responde sem expor dados sensíveis', async () => {
  const r = await fetch(`${BASE}/api/teste/config`);
  const d = await j(r);
  assert.equal(r.status, 200);
  assert.equal(d.service.durationMin, 60);
  assert.equal(d.timezone, 'America/Sao_Paulo');
  assert.ok(!JSON.stringify(d).includes('password'));
});

await teste('1. agendamento normal', async () => {
  const r = await agendar(base());
  const d = await j(r);
  assert.equal(r.status, 201, JSON.stringify(d));
  assert.equal(d.status, 'pending');
  assert.equal(d.horaFormatada, '10:00');
  assert.match(d.code, /^[0-9A-F]{8}$/);
});

await teste('2. horário duplicado é recusado pelo banco', async () => {
  const r = await agendar(base({ name: 'Outra Pessoa', email: 'outra@exemplo.com' }));
  const d = await j(r);
  assert.equal(r.status, 409, JSON.stringify(d));
  assert.equal(d.error, 'horario_indisponivel');
});

await teste('2b. corrida: 5 pedidos simultâneos, só 1 vence', async () => {
  const rs = await Promise.all([...Array(5)].map((_, i) =>
    agendar(base({ time: '11:00', email: `corrida${i}@exemplo.com` }))));
  const criados = rs.filter(r => r.status === 201).length;
  const conflitos = rs.filter(r => r.status === 409).length;
  assert.equal(criados, 1, `criados=${criados}`);
  assert.equal(conflitos, 4, `conflitos=${conflitos}`);
});

await teste('o horário reservado some da disponibilidade', async () => {
  const d = await j(await fetch(`${BASE}/api/teste/availability?from=${amanha}&to=${amanha}&modality=online`));
  assert.ok(!(d.days[amanha] || []).includes('10:00'));
  assert.ok((d.days[amanha] || []).includes('12:00'));
});

await teste('4. data no passado é recusada', async () => {
  const r = await agendar(base({ date: ontem }));
  assert.equal(r.status, 409);
});

await teste('5. campos inválidos retornam 422 por campo', async () => {
  const r = await agendar(base({ name: '', email: 'nao-e-email', whatsapp: '123', time: '13:00' }));
  const d = await j(r);
  assert.equal(r.status, 422);
  assert.ok(d.campos.name && d.campos.email && d.campos.whatsapp);
});

await teste('5b. sem aceite da política, não agenda', async () => {
  const r = await agendar(base({ time: '14:00', privacy: false }));
  const d = await j(r);
  assert.equal(r.status, 422);
  assert.ok(d.campos.privacy);
});

await teste('5c. horário fora da janela de atendimento é recusado', async () => {
  const r = await agendar(base({ time: '23:00' }));
  assert.equal(r.status, 409);
});

console.log('\nadministração');

await teste('6. /admin exige autenticação', async () => {
  for (const rota of ['/api/admin/me', '/api/admin/appointments', '/api/admin/settings']) {
    const r = await fetch(BASE + rota);
    assert.equal(r.status, 401, rota);
  }
});

await teste('6b. senha errada não autentica', async () => {
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@teste.local', password: 'errada' })
  });
  assert.equal(r.status, 401);
});

let cookie = '';
await teste('login válido devolve cookie HttpOnly', async () => {
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@teste.local', password: 'senha-de-teste-123' })
  });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie') || '';
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  cookie = sc.split(';')[0];
});

const adm = (rota, opts = {}) => fetch(BASE + '/api/admin' + rota, {
  ...opts,
  headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'X-Requested-With': 'agenda-admin', ...(opts.headers || {}) },
  body: opts.body ? JSON.stringify(opts.body) : undefined
});

await teste('6c. escrita sem o cabeçalho anti-CSRF é barrada', async () => {
  const r = await fetch(BASE + '/api/admin/blocks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
    body: JSON.stringify({ starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 3600e3).toISOString() })
  });
  assert.equal(r.status, 403);
});

await teste('lista agendamentos e confirma um', async () => {
  const d = await j(await adm('/appointments'));
  assert.ok(d.appointments.length >= 2);
  const alvo = d.appointments.find(a => a.status === 'pending');
  const r = await adm('/appointments/' + alvo.id, { method: 'PATCH', body: { status: 'confirmed' } });
  assert.equal(r.status, 200);
  assert.equal((await j(r)).status, 'confirmed');
});

await teste('3. período bloqueado remove os horários do dia', async () => {
  const depois = addDaysStr(amanha, 1);
  const ini = new Date(`${depois}T09:00:00-03:00`).toISOString();
  const fim = new Date(`${depois}T23:59:00-03:00`).toISOString();
  const r = await adm('/blocks', { method: 'POST', body: { starts_at: ini, ends_at: fim, reason: 'Férias' } });
  assert.equal(r.status, 201);

  const disp = await j(await fetch(`${BASE}/api/teste/availability?from=${depois}&to=${depois}&modality=online`));
  assert.ok(!disp.days[depois], 'o dia deveria estar sem horários');

  const bloq = await agendar(base({ date: depois, time: '15:00' }));
  assert.equal(bloq.status, 409);
});

await teste('reagendar respeita a trava de duplicidade', async () => {
  const d = await j(await adm('/appointments'));
  const a = d.appointments.find(x => x.status === 'confirmed');
  const ocupado = d.appointments.find(x => x.id !== a.id && x.status !== 'cancelled');
  const [dataOcupada, horaOcupada] = [ocupado.starts_at.slice(0, 10), ocupado.hora];
  const r = await adm('/appointments/' + a.id, {
    method: 'PATCH', body: { date: amanha, time: horaOcupada }
  });
  assert.equal(r.status, 409, `esperava conflito em ${dataOcupada} ${horaOcupada}`);
});

await teste('salvar disponibilidade inválida é recusado', async () => {
  const r = await adm('/availability', {
    method: 'PUT', body: { availability: [{ weekday: 9, start_time: '09:00', end_time: '10:00' }] }
  });
  assert.equal(r.status, 422);
});

await teste('configurações fora do limite são recusadas', async () => {
  const r = await adm('/settings', { method: 'PUT', body: { max_advance_days: 5000 } });
  assert.equal(r.status, 422);
});

await teste('logout invalida a sessão', async () => {
  assert.equal((await adm('/logout', { method: 'POST' })).status, 200);
  assert.equal((await adm('/me')).status, 401);
});

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(falhou ? 1 : 0);
