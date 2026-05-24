# Deploy — LOBBY v3 Fase 1

---

## 1. Backend (Render)

Deploy automático via GitHub. Qualquer push para `main` aciona um redeploy.

```bash
cd /workspaces/lobby-backend
git add .
git commit -m "feat: descrição da mudança"
git push origin main
# Render detecta o push e redeploya em ~1–2 min
```

**URL:** https://lobby-backend-tp84.onrender.com  
**Anti-sleep:** cron-job.org pinga `/health` a cada 5 minutos (free tier dorme após 15min de inatividade)

### Variáveis de ambiente no Render

Configurar em **Dashboard → Environment**:

| Variável | Valor |
|----------|-------|
| `JWT_SECRET` | string longa e aleatória (ex: `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |
| `ALLOWED_ORIGINS` | `https://seu-frontend.vercel.app,https://lobby-backend-tp84.onrender.com` |

---

## 2. Frontend principal (Vercel)

```bash
cd /workspaces/lobby-pdv-v2
git add index.html
git commit -m "feat: Adiciona 4 novos módulos no PDV"
git push origin main
# Vercel faz redeploy automático
```

> O frontend faz requests relativas (`API_URL = ''`), então funciona em qualquer domínio sem configuração.

---

## 3. App da faxineira (PWA)

A `cleaning-app.html` é servida diretamente pelo backend Render — não precisa de deploy separado.

**URL:** `https://lobby-backend-tp84.onrender.com/cleaning-app.html`

Para criar um link de instalação exclusivo por faxineira, gere a URL com `?staffId=<uuid>` e envie por WhatsApp.

Se quiser hospedar em domínio separado (ex: `lobby-cleaning.vercel.app`):

```bash
# Crie um repo só com cleaning-app.html, manifest.json, sw.js e os ícones
# Aponte para Vercel → deploy automático
# Configure API_URL para https://lobby-backend-tp84.onrender.com no topo do cleaning-app.html
```

---

## 4. Migrations no Supabase (v3)

Executar quando migrar do in-memory store para banco de dados persistente.

### Passo a passo

1. Crie um projeto em [supabase.com](https://supabase.com)
2. Anote a **Project URL** e a **anon/service key**
3. Acesse **SQL Editor** no dashboard
4. Cole o conteúdo de `migrations.sql` e clique em **Run**
5. Verifique as tabelas em **Table Editor**

### Tabelas criadas pelo migrations.sql

```
cleaning_staff
cleaning_tasks
cleaning_inspections
fnrh_records
seasons
```

> As tabelas base (`users`, `rooms`, `guests`, `stays`, `invoices`, `hotels`) devem existir previamente (schema v1/v2).

### Variáveis de ambiente após Supabase

Adicionar no Render:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

---

## 5. Verificar deploy

```bash
# Health check
curl https://lobby-backend-tp84.onrender.com/health

# Login demo
curl -s -X POST https://lobby-backend-tp84.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.com","password":"demo123"}' | jq '{token: .token[0:40]}'

# Dashboard
TOKEN=$(curl -s -X POST https://lobby-backend-tp84.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.com","password":"demo123"}' | jq -r '.token')

curl -s "https://lobby-backend-tp84.onrender.com/api/hotels/a1b2c3d4-e5f6-4890-a123-456789abcdef/dashboard/stats" \
  -H "Authorization: Bearer $TOKEN" | jq '{occupancyRate, totalRooms, revenueThisMonth}'
```

Para suite completa de testes, ver [tests.md](./tests.md).
