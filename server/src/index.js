import 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// .env sem dependência externa
const raiz = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(raiz, '.env');
if (fs.existsSync(envPath)) {
  for (const linha of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { publicRouter } = await import('./routes/public.js');
const { adminRouter } = await import('./routes/admin.js');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

// Cabeçalhos de segurança
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
  });
  const permitidas = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origem = req.headers.origin;
  if (origem && permitidas.includes(origem)) {
    res.set({
      'Access-Control-Allow-Origin': origem,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Vary': 'Origin'
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', publicRouter);
app.use('/api/admin', adminRouter);

// Painel da profissional (a autenticação real está na API, não aqui)
const publico = path.join(raiz, 'public');
app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(publico, 'admin.html')));
app.use('/admin-assets', express.static(publico, { maxAge: '1h' }));

// Landing page
const site = path.dirname(raiz);
app.use(express.static(site, { maxAge: '1h', index: 'index.html' }));

app.use((_req, res) => res.status(404).json({ error: 'nao_encontrado' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'erro_interno' });
});

const porta = Number(process.env.PORT || 3000);
export const server = app.listen(porta, () => console.log(`agenda em http://localhost:${porta}`));
export { app };
