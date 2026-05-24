# LOBBY Backend — v3 Fase 1

Sistema de Gestão Hoteleira (PMS) — backend completo em Node.js + Express com store in-memory para demo.

**Produção:** https://lobby-backend-tp84.onrender.com  
**Login demo:** `admin@demo.com` / `demo123`  
**Hotel ID (seed):** `a1b2c3d4-e5f6-4890-a123-456789abcdef`

---

## Índice

- [Stack](#stack)
- [Rodar localmente](#rodar-localmente)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Endpoints](#endpoints)
- [Testar](#testar)
- [Migrations (Supabase)](#migrations-supabase)
- [Deploy](#deploy)
- [Arquitetura](#arquitetura)

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Auth | JWT (jsonwebtoken) + bcrypt |
| Validação | Zod |
| Segurança | helmet, express-rate-limit, CORS dinâmico |
| Store | In-memory (`Map`) — sem banco em produção atual |
| DB futuro | Supabase (PostgreSQL) — schema em `migrations.sql` |
| Deploy | Render (free tier, auto-deploy via GitHub) |
| Frontend | `index.html` (SPA vanilla JS, servido pelo mesmo Express) |
| App faxineira | `cleaning-app.html` (PWA instalável, login por PIN) |

---

## Rodar localmente

```bash
git clone https://github.com/matioli616/lobby-backend
cd lobby-backend
npm install
npm start
# → http://localhost:10000
```

---

## Variáveis de ambiente

| Variável | Padrão | Obrigatório em produção |
|----------|--------|-------------------------|
| `PORT` | `10000` | Não |
| `JWT_SECRET` | `lobby-demo-secret-2026` | **Sim** — lança exceção se ausente |
| `NODE_ENV` | `development` | Recomendado (`production`) |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:10000` | Sim — domínios CORS permitidos |

O servidor sempre permite o próprio domínio de origem (`req.protocol + host`), independente de `ALLOWED_ORIGINS`.

---

## Endpoints

46 endpoints no total. Base URL: `https://lobby-backend-tp84.onrender.com`

### Sistema

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `GET` | `/health` | — | Health check `{status:"ok"}` |
| `GET` | `/api/status` | — | Versão e modo |
| `GET` | `/` | — | Frontend SPA (`index.html`) |
| `GET` | `/cleaning-app.html` | — | PWA faxineira |
| `GET` | `/manifest.json` | — | Manifest PWA |
| `GET` | `/sw.js` | — | Service Worker PWA |
| `GET` | `/icon-192.png` | — | Ícone PWA 192px |
| `GET` | `/icon-512.png` | — | Ícone PWA 512px |

### Auth

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `POST` | `/api/auth/login` | — | Login admin → JWT + cookie httpOnly |
| `POST` | `/api/auth/refresh` | Cookie | Renova sessão sem re-login |
| `POST` | `/api/auth/logout` | Cookie | Limpa cookie |

### Dashboard

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `GET` | `/api/hotels/:hotelId/dashboard/stats` | Admin | `totalRooms`, `occupancyRate`, `revenueThisMonth`, `revPAR`, etc. |

### Quartos

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `GET` | `/api/hotels/:hotelId/rooms` | Admin | Lista quartos com status em tempo real |

### Hóspedes

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `POST` | `/api/hotels/:hotelId/guests` | Admin | Cadastra hóspede (valida CPF com dígitos verificadores) |
| `GET` | `/api/hotels/:hotelId/guests` | Admin | Lista hóspedes |

### Hospedagens

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `POST` | `/api/hotels/:hotelId/stays` | Admin | Check-in |
| `GET` | `/api/hotels/:hotelId/stays/active/room/:roomId` | Admin | Hospedagem ativa por quarto |
| `PUT` | `/api/stays/:stayId/checkout` | Admin | Checkout + gera invoice |

### Governança — Equipe de Limpeza

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `GET` | `/api/hotels/:hotelId/cleaning/staff` | Admin | Lista faxineiras |
| `POST` | `/api/hotels/:hotelId/cleaning/staff` | Admin | Cria faxineira (PIN 4–6 dígitos, bcrypt) |
| `PUT` | `/api/hotels/:hotelId/cleaning/staff/:staffId` | Admin | Edita nome / telefone / PIN |
| `DELETE` | `/api/hotels/:hotelId/cleaning/staff/:staffId` | Admin | Desativa faxineira (soft delete) |

### Governança — Tarefas de Limpeza

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `GET` | `/api/hotels/:hotelId/cleaning/tasks` | Admin | Lista tarefas (filtros: `status`, `staffId`) |
| `POST` | `/api/hotels/:hotelId/cleaning/tasks` | Admin | Cria tarefa para um quarto |
| `PUT` | `/api/cleaning/tasks/:taskId/start` | Admin/Staff | `pending → in_progress` |
| `PUT` | `/api/cleaning/tasks/:taskId/complete` | Admin/Staff | `in_progress → done` |
| `PUT` | `/api/cleaning/tasks/:taskId/inspect` | Admin | `done → inspected` ou `inspection_failed` + nova task |
| `POST` | `/api/hotels/:hotelId/cleaning/tasks/generate-daily` | Admin | Gera tarefas do dia (checkout + daily) |

### App Faxineira (PWA)

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `POST` | `/api/cleaning/auth/login` | — | Login por `staffId` + PIN → JWT staff (12h) |
| `GET` | `/api/cleaning/my-tasks` | Staff | Tarefas da faxineira autenticada (pending + in_progress + done de hoje) |

### Tarifário Dinâmico

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `GET` | `/api/hotels/:hotelId/seasons` | Admin | Lista temporadas |
| `POST` | `/api/hotels/:hotelId/seasons` | Admin | Cria temporada (valida sobreposição de datas por tipo) |
| `PUT` | `/api/hotels/:hotelId/seasons/:seasonId` | Admin | Edita campos parciais da temporada |
| `DELETE` | `/api/hotels/:hotelId/seasons/:seasonId` | Admin | Remove temporada |
| `GET` | `/api/hotels/:hotelId/weekday-multipliers` | Admin | Lê multiplicadores por dia da semana (0=dom … 6=sab) |
| `PUT` | `/api/hotels/:hotelId/weekday-multipliers` | Admin | Salva multiplicadores (range 0.5–3.0) |
| `GET` | `/api/hotels/:hotelId/tariff/calculate` | Admin | Calcula tarifa dia a dia (`?roomId&checkin&checkout`) |

### FNRH — Ficha Nacional de Registro de Hóspedes

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `POST` | `/api/hotels/:hotelId/fnrh` | Admin | Cria FNRH (valida CPF, datas, UF, correspondência guest/stay) |
| `GET` | `/api/hotels/:hotelId/fnrh` | Admin | Lista FNRHs (filtros: `month=YYYY-MM`, `exported=true/false`) |
| `PUT` | `/api/hotels/:hotelId/fnrh/:recordId` | Admin | Edita FNRH (bloqueado após exportação) |
| `GET` | `/api/hotels/:hotelId/fnrh/export` | Admin | Gera `.txt` SISMATUR pipe-separated (`?month=YYYY-MM`) |

### Relatórios

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| `GET` | `/api/hotels/:hotelId/reports/occupancy` | Admin | Taxa de ocupação diária e comparativo (`?from&to`, default últimos 30 dias) |
| `GET` | `/api/hotels/:hotelId/reports/revenue` | Admin | Receita total, ADR, RevPAR, por tipo de quarto e forma de pagamento |
| `GET` | `/api/hotels/:hotelId/reports/guests` | Admin | Perfil de hóspedes: origem, faixa etária, motivo da viagem, duração média |
| `GET` | `/api/hotels/:hotelId/reports/staff-performance` | Admin | Performance por faxineira: tarefas, tempo médio, nota de inspeção |
| `GET` | `/api/hotels/:hotelId/reports/financial` | Admin | Financeiro consolidado: receita, ADR, RevPAR, comparativo período anterior |

---

## Testar

Ver [tests.md](./tests.md) — cobertura completa dos 46 endpoints com `curl` + `jq`, organizado por módulo.

```bash
export API_URL="http://localhost:10000"
export HOTEL_ID="a1b2c3d4-e5f6-4890-a123-456789abcdef"

export TOKEN=$(curl -s -X POST $API_URL/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.com","password":"demo123"}' | jq -r '.token')
```

---

## Migrations (Supabase)

`migrations.sql` contém o schema PostgreSQL completo para migrar do store in-memory para Supabase.

### Passo a passo

1. Crie um projeto em [supabase.com](https://supabase.com)
2. Acesse **SQL Editor** no dashboard
3. Cole o conteúdo de `migrations.sql` e clique em **Run**
4. Verifique as tabelas em **Table Editor**

### Tabelas criadas

| Tabela | Módulo |
|--------|--------|
| `cleaning_staff` | Governança |
| `cleaning_tasks` | Governança |
| `cleaning_inspections` | Governança |
| `fnrh_records` | FNRH |
| `seasons` | Tarifário Dinâmico |

> As tabelas `users`, `rooms`, `guests`, `stays`, `invoices`, `hotels` pertencem ao schema base (v1/v2) e devem já existir.

---

## Deploy

Deploy automático: push para `main` → Render redeploya em ~1–2 min.

```bash
git add .
git commit -m "feat: descrição"
git push origin main
```

Ver [deploy.md](./deploy.md) para instruções completas (backend + frontend + PWA + Supabase).

---

## Arquitetura

```
lobby-backend/
├── server.js           # Backend completo (Express + rotas + in-memory DB + seed)
├── index.html          # Frontend SPA (vanilla JS, CSS inline)
├── cleaning-app.html   # PWA faxineira (instalável, offline-capable)
├── sw.js               # Service Worker (cache PWA)
├── manifest.json       # Manifest PWA
├── migrations.sql      # Schema PostgreSQL para Supabase (v3)
├── CLAUDE.md           # Documentação da arquitetura para Claude Code
├── tests.md            # Suite de testes curl completa (46 endpoints)
├── deploy.md           # Guia de deploy
└── CHANGELOG.md        # Histórico de versões
```

### Segurança implementada

- JWT `expiresIn: 8h` (admin) / `12h` (staff)
- Cookie `httpOnly` + `sameSite: strict` para refresh de sessão
- `bcrypt` para senhas de admin e PINs de faxineiras
- `helmet` com CSP, HSTS, X-Frame-Options, CORP
- Rate limiting: 300 req/15min global, 20 logins/15min
- `enforceHotelOwnership` em todas as rotas de hotel (proteção IDOR)
- Validação com `zod` em todos os inputs
- CORS: allowlist explícita + auto-detecção do domínio próprio
