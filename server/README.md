# Módulo de agenda

Backend de agendamento da landing page. Node + SQLite, sem serviços externos.

## Subir

```bash
cd server
npm install               # obrigatório antes de qualquer outro comando
cp .env.example .env      # no Windows: copy .env.example .env
                          # preencher ADMIN_EMAIL e ADMIN_PASSWORD
npm run seed              # cria tenant, usuária, serviço e grade inicial
npm start                 # serve a landing em / e o painel em /admin
```

Precisa de Node 22.5 ou mais novo (Node 24 recomendado).

A única dependência é o Express — JavaScript puro. O banco usa o SQLite embutido
no próprio Node (`node:sqlite`), então **nada é compilado**: não é preciso ter
Python nem as ferramentas de build do Visual Studio instaladas.

Se você já tinha rodado uma versão anterior deste projeto, apague a pasta
`server/node_modules` e o arquivo `server/package-lock.json` antes de instalar
de novo — eles ainda apontam para o driver antigo, que exigia compilação.

O `npm run seed` é idempotente: rodar de novo não sobrescreve dados — inclusive
**não troca a senha** de um acesso que já existe. Para isso, use o comando abaixo.

## Login e senha do painel

Primeiro acesso: `ADMIN_EMAIL` e `ADMIN_PASSWORD` no `.env` + `npm run seed`.

Depois disso, o `.env` deixa de mandar. Para trocar:

```bash
npm run senha -- adriana@dominio.com "nova senha de pelo menos 10 caracteres"
```

Troca a senha se o e-mail já existir, cria o acesso se for novo, e derruba as
sessões abertas. Para remover um acesso antigo (nunca o último):

```bash
npm run senha -- --remover email@antigo.com
```

A senha só é gravada como hash scrypt — não fica em texto no banco nem no `.env`
depois do primeiro seed.

## Testes

```bash
npm test
```

Sobe o servidor com banco temporário e cobre: agendamento normal, duplicidade,
corrida de 5 pedidos simultâneos, período bloqueado, data passada, campos
inválidos, aceite da política, acesso não autorizado ao /admin e CSRF.

## Rotas

Públicas — `/api/:slug/…`

| método | rota | uso |
|---|---|---|
| GET | `/config` | dados que o modal precisa (nome, fuso, duração, modalidades) |
| GET | `/availability?from&to&modality` | dias e horários livres |
| POST | `/appointments` | reserva |

Administrativas — `/api/admin/…`, exigem cookie de sessão e o cabeçalho
`X-Requested-With: agenda-admin` nas escritas.

`login` · `logout` · `me` · `appointments` (GET, PATCH) · `slots` ·
`blocks` (GET, POST, DELETE) · `availability` (GET, PUT) · `settings` (GET, PUT)

## Reaproveitar para outra profissional

Tudo o que é específico da cliente está em `tenants` + `.env`. Para servir outra
landing page:

1. `TENANT_SLUG`, `TENANT_NAME`, `TENANT_TIMEZONE`, `TENANT_WHATSAPP` no `.env`
2. `npm run seed`
3. na landing: `<body data-agenda-slug="novo-slug">`

A lógica de agenda (`src/lib/schedule.js`) é pura e não conhece Express nem SQL.

## Onde hospedar

Precisa de um processo Node com disco persistente para o SQLite — Render,
Railway, Fly.io ou uma VPS. Hospedagem estática pura (Netlify/GitHub Pages) roda
a landing, mas sem agendamento: nesse caso os botões voltam a abrir o WhatsApp
sozinhos, sem quebrar nada.

## Backup

O banco é o arquivo em `DB_PATH`. Copiar `agenda.db`, `agenda.db-wal` e
`agenda.db-shm` com o servidor parado é backup completo.
