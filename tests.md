# Testes — LOBBY Backend

Cobre todos os 35 endpoints do sistema. Execute na ordem — cada seção usa variáveis
definidas nas seções anteriores.

> **Ambiente local:** substitua `$API_URL` por `http://localhost:10000`  
> **Produção:** use `https://lobby-backend-tp84.onrender.com`

---

## 0. Setup Inicial

```bash
export API_URL="http://localhost:10000"
export HOTEL_ID="a1b2c3d4-e5f6-4890-a123-456789abcdef"
```

Iniciar servidor (se local):

```bash
node server.js
# ou
npm start
```

---

## 1. Sistema

### Health check

```bash
curl $API_URL/health
# → {"status":"ok","uptime":...}
```

### Status da API

```bash
curl $API_URL/api/status
# → {"name":"LOBBY Backend","status":"running","mode":"demo"}
```

### Assets PWA (deve retornar 200)

```bash
curl -o /dev/null -w "%{http_code}" $API_URL/cleaning-app.html  # 200
curl -o /dev/null -w "%{http_code}" $API_URL/manifest.json       # 200
curl -o /dev/null -w "%{http_code}" $API_URL/sw.js               # 200
curl -o /dev/null -w "%{http_code}" $API_URL/icon-192.png        # 200
curl -o /dev/null -w "%{http_code}" $API_URL/icon-512.png        # 200
```

---

## 2. Auth

### Login — sucesso

```bash
curl -s -X POST $API_URL/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.com","password":"demo123"}' | jq .
```

**Salvar o token:**

```bash
export TOKEN=$(curl -s -X POST $API_URL/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.com","password":"demo123"}' \
  | jq -r '.token')

echo "TOKEN: ${TOKEN:0:50}..."
```

### Login — credenciais erradas → 401

```bash
curl -s -X POST $API_URL/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.com","password":"senhaerrada"}'
# → {"error":"Email ou senha inválidos","code":"INVALID_CREDENTIALS"}
```

### Login — body inválido → 400

```bash
curl -s -X POST $API_URL/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"nao-e-email","password":"123"}'
# → {"error":"Dados inválidos","code":"VALIDATION_ERROR"}
```

### Refresh de sessão (usa cookie httpOnly)

```bash
# Primeiro fazer login salvando o cookie:
curl -s -c /tmp/lobby_cookie.txt -X POST $API_URL/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.com","password":"demo123"}' | jq '{token: .token[0:40]}'

# Refresh com o cookie:
curl -s -b /tmp/lobby_cookie.txt -X POST $API_URL/api/auth/refresh | jq '{token: .token[0:40]}'
```

### Logout (limpa cookie)

```bash
curl -s -b /tmp/lobby_cookie.txt -X POST $API_URL/api/auth/logout
# → {"success":true}
```

---

## 3. Dashboard

### Stats do hotel

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/dashboard/stats" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {occupancyRate, availableRooms, occupiedRooms, cleaningRooms,
#    revenueThisMonth, revPAR, checkinsToday, checkoutsToday, ...}
```

---

## 4. Quartos

### Listar quartos

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/rooms" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Salvar IDs de quartos para os próximos testes:**

```bash
export ROOM_AVAILABLE=$(curl -s "$API_URL/api/hotels/$HOTEL_ID/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.[] | select(.status=="available")][0].id')

export ROOM_NUMBER=$(curl -s "$API_URL/api/hotels/$HOTEL_ID/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.[] | select(.status=="available")][0].roomNumber')

echo "Quarto disponível: $ROOM_NUMBER (ID: $ROOM_AVAILABLE)"
```

---

## 5. Hóspedes

### Criar hóspede — completo

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/guests" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "cpf": "52998224725",
    "name": "João Silva Santos",
    "email": "joao.silva@email.com",
    "phone": "11987654321"
  }' | jq .
```

### Criar hóspede — mínimo (só campos obrigatórios)

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/guests" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "cpf": "07987135438",
    "name": "Maria Oliveira"
  }' | jq .
```

**Salvar GUEST_ID:**

```bash
export GUEST_ID=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/guests" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cpf":"98765432100","name":"Carlos Pereira","email":"carlos@hotel.test","phone":"71999990000"}' \
  | jq -r '.id')

echo "Guest ID: $GUEST_ID"
```

### CPF inválido → 400

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/guests" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cpf":"11111111111","name":"Teste Inválido"}'
# → {"error":"Dados inválidos","code":"VALIDATION_ERROR"}
```

### Listar hóspedes

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/guests" \
  -H "Authorization: Bearer $TOKEN" | jq '[.[] | {id, name, cpf}]'
```

---

## 6. Hospedagens (Check-in / Checkout)

### Check-in

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/stays" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"guestId\": \"$GUEST_ID\",
    \"roomId\":  \"$ROOM_AVAILABLE\",
    \"numberOfNights\": 3
  }" | jq .
```

**Salvar STAY_ID:**

```bash
export STAY_ID=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/stays" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"guestId\":\"$GUEST_ID\",\"roomId\":\"$ROOM_AVAILABLE\",\"numberOfNights\":2}" \
  | jq -r '.id')

echo "Stay ID: $STAY_ID"
```

### Check-in em quarto ocupado → 400

```bash
# Tente dar check-in no mesmo quarto de novo
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/stays" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"guestId\":\"$GUEST_ID\",\"roomId\":\"$ROOM_AVAILABLE\",\"numberOfNights\":1}"
# → {"error":"Quarto não disponível","code":"ROOM_NOT_AVAILABLE"}
```

### Buscar hospedagem ativa por quarto

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/stays/active/room/$ROOM_AVAILABLE" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### Checkout

```bash
curl -s -X PUT "$API_URL/api/stays/$STAY_ID/checkout" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethod":"pix","paymentStatus":"paid"}' | jq .
# → {"success":true,"total":...}
```

### Checkout duplo → 409

```bash
curl -s -X PUT "$API_URL/api/stays/$STAY_ID/checkout" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paymentMethod":"dinheiro"}'
# → {"error":"Checkout já realizado","code":"ALREADY_CHECKED_OUT"}
```

---

## 7. Governança — Equipe de Limpeza

### Listar faxineiras

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff" \
  -H "Authorization: Bearer $TOKEN" | jq '[.[] | {id, name, phone, isActive}]'
```

**Salvar STAFF_ID (primeira faxineira ativa):**

```bash
export STAFF_ID=$(curl -s "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.[] | select(.isActive==true)][0].id')

export STAFF_NAME=$(curl -s "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.[] | select(.isActive==true)][0].name')

echo "Faxineira: $STAFF_NAME (ID: $STAFF_ID)"
```

> **Faxineiras do seed:**  
> Ana Lima — PIN `123456`  
> Beatriz Costa — PIN `567890`  
> Carla Mendes — PIN `901234`

### Criar nova faxineira

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":  "Daniela Rocha",
    "pin":   "112233",
    "phone": "71988880004"
  }' | jq .
# → {id, hotelId, name, phone, isActive: true, createdAt}
# PIN nunca é retornado na resposta
```

**Salvar ID da nova faxineira:**

```bash
export NEW_STAFF_ID=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Eliana Souza","pin":"998877","phone":"71977770005"}' \
  | jq -r '.id')

echo "Nova faxineira ID: $NEW_STAFF_ID"
```

### PIN inválido (menos de 4 dígitos) → 400

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Teste PIN","pin":"12"}'
# → {"error":"PIN deve ter 4–6 dígitos","code":"VALIDATION_ERROR"}
```

### Atualizar faxineira (nome e telefone)

```bash
curl -s -X PUT "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff/$NEW_STAFF_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":  "Eliana Souza Lima",
    "phone": "71977770099"
  }' | jq .
```

### Alterar PIN da faxineira

```bash
curl -s -X PUT "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff/$NEW_STAFF_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pin":"445566"}' | jq '{id, name}'
# PIN é re-hasheado, não aparece na resposta
```

### Desativar faxineira

```bash
curl -s -X DELETE "$API_URL/api/hotels/$HOTEL_ID/cleaning/staff/$NEW_STAFF_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {"success":true}
```

---

## 8. Governança — Tarefas (token admin)

> **Nota:** os endpoints de start/complete/inspect aceitam token de admin OU token de faxineira.
> Para testes com token de faxineira, veja a seção 9.

### Listar tarefas (todos os status)

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/cleaning/tasks" \
  -H "Authorization: Bearer $TOKEN" | jq '[.[] | {id, roomNumber, status, priority, assignedTo}]'
```

### Listar tarefas — filtro por status

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/cleaning/tasks?status=pending" \
  -H "Authorization: Bearer $TOKEN" | jq '[.[] | {id, roomNumber, status}]'
```

### Listar tarefas — filtro por faxineira

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/cleaning/tasks?staffId=$STAFF_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '[.[] | {id, roomNumber, status, priority}]'
```

### Criar tarefa — completa

```bash
# Pegue um quarto disponível que não tenha tarefa ativa
export ROOM_FOR_TASK=$(curl -s "$API_URL/api/hotels/$HOTEL_ID/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.[] | select(.status=="available")][0].id')

curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/cleaning/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"roomId\":           \"$ROOM_FOR_TASK\",
    \"assignedTo\":       \"$STAFF_ID\",
    \"priority\":         \"urgent\",
    \"estimatedMinutes\": 45,
    \"notes\":            \"Checkout ontem — prioridade máxima\"
  }" | jq .
```

**Salvar TASK_ID:**

```bash
export TASK_ID=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/cleaning/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"roomId\":\"$ROOM_FOR_TASK\",\"assignedTo\":\"$STAFF_ID\",\"priority\":\"normal\",\"estimatedMinutes\":30}" \
  | jq -r '.id')

echo "Task ID: $TASK_ID"
```

### Criar tarefa — sem atribuição (pool geral)

```bash
export ROOM2=$(curl -s "$API_URL/api/hotels/$HOTEL_ID/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.[] | select(.status=="available")][1].id')

curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/cleaning/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"roomId\":\"$ROOM2\",\"priority\":\"high\",\"estimatedMinutes\":60}" | jq .
```

### Iniciar tarefa (pending → in_progress)

```bash
curl -s -X PUT "$API_URL/api/cleaning/tasks/$TASK_ID/start" \
  -H "Authorization: Bearer $TOKEN" | jq '{id, status, startedAt}'
# → status: "in_progress", startedAt: "<timestamp>"
```

### Tarefa já iniciada → 400

```bash
curl -s -X PUT "$API_URL/api/cleaning/tasks/$TASK_ID/start" \
  -H "Authorization: Bearer $TOKEN"
# → {"error":"Tarefa não está pendente","code":"INVALID_STATUS"}
```

### Concluir tarefa (in_progress → done)

```bash
curl -s -X PUT "$API_URL/api/cleaning/tasks/$TASK_ID/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "actualMinutes": 28,
    "notes": "Quarto limpo, cama feita, banheiro higienizado"
  }' | jq '{id, status, actualMinutes, completedAt}'
# → status: "done"
```

### Concluir tarefa — sem campos opcionais

```bash
curl -s -X PUT "$API_URL/api/cleaning/tasks/$TASK_ID/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '{id, status}'
# Funciona — actualMinutes calculado automaticamente se startedAt existe
```

### Inspecionar tarefa — aprovado (done → inspected)

```bash
curl -s -X PUT "$API_URL/api/cleaning/tasks/$TASK_ID/inspect" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "score":  5,
    "notes":  "Quarto impecável",
    "passed": true
  }' | jq '{task: {status: .task.status}, passed}'
# → task.status: "inspected", quarto volta para "available"
```

### Inspecionar tarefa — reprovado (done → inspection_failed + nova tarefa)

```bash
# Precisa de uma tarefa no status "done" — criar novo ciclo:
export TASK_FAIL=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/cleaning/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"roomId\":\"$ROOM_FOR_TASK\",\"assignedTo\":\"$STAFF_ID\",\"priority\":\"normal\",\"estimatedMinutes\":30}" \
  | jq -r '.id')

curl -s -X PUT "$API_URL/api/cleaning/tasks/$TASK_FAIL/start" \
  -H "Authorization: Bearer $TOKEN" > /dev/null

curl -s -X PUT "$API_URL/api/cleaning/tasks/$TASK_FAIL/complete" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{}' > /dev/null

curl -s -X PUT "$API_URL/api/cleaning/tasks/$TASK_FAIL/inspect" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "score":  2,
    "notes":  "Banheiro sujo, cama mal feita",
    "passed": false
  }' | jq '{task: {status: .task.status}, passed}'
# → task.status: "inspection_failed"
# Uma nova tarefa com priority: "high" e notes "Retrabalho..." é criada automaticamente
```

### Gerar tarefas diárias (baseado em checkouts do dia)

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/cleaning/tasks/generate-daily" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {generated: N, message: "N tarefa(s) gerada(s)"}
# Cria 1 tarefa de checkout para cada quarto com checkout hoje
# Cria 1 tarefa de daily para quartos ocupados que ficam mais 1 dia
```

---

## 9. App Faxineira (STAFF_TOKEN)

> **Atenção:** use o endpoint de login de faxineira — gera token com `role: "cleaning_staff"`.
> Token de faxineira NÃO funciona nas rotas admin (dashboard, guests, FNRH, etc.).

### Login da faxineira (por staffId + PIN)

```bash
# staffId de Ana Lima (do seed — muda a cada restart do servidor)
# Use o STAFF_ID exportado na seção 7

curl -s -X POST $API_URL/api/cleaning/auth/login \
  -H "Content-Type: application/json" \
  -d "{
    \"staffId\": \"$STAFF_ID\",
    \"pin\":     \"123456\"
  }" | jq .
# → {token: "...", staff: {id, hotelId, name, phone, isActive}}
```

**Salvar STAFF_TOKEN:**

```bash
export STAFF_TOKEN=$(curl -s -X POST $API_URL/api/cleaning/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"staffId\":\"$STAFF_ID\",\"pin\":\"123456\"}" \
  | jq -r '.token')

echo "Staff token: ${STAFF_TOKEN:0:50}..."
```

### PIN errado → 401

```bash
curl -s -X POST $API_URL/api/cleaning/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"staffId\":\"$STAFF_ID\",\"pin\":\"000000\"}"
# → {"error":"PIN inválido ou conta inativa","code":"INVALID_CREDENTIALS"}
```

### Listar minhas tarefas (GET /api/cleaning/my-tasks)

```bash
curl -s $API_URL/api/cleaning/my-tasks \
  -H "Authorization: Bearer $STAFF_TOKEN" | jq \
  '[.[] | {roomNumber, status, priority, estimatedMinutes}]'
# → tarefas pending + in_progress da faxineira
# + tarefas done/inspected de hoje (para o contador)
# Ordenadas: pending > in_progress > done, por prioridade
```

### Token admin no my-tasks → 403

```bash
curl -s $API_URL/api/cleaning/my-tasks \
  -H "Authorization: Bearer $TOKEN"
# → {"error":"Acesso negado","code":"FORBIDDEN"}
# verifyStaffToken rejeita tokens sem role: "cleaning_staff"
```

### Iniciar tarefa com STAFF_TOKEN

```bash
# Pegar uma tarefa pending da faxineira
export MY_TASK=$(curl -s $API_URL/api/cleaning/my-tasks \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  | jq -r '[.[] | select(.status=="pending")][0].id')

echo "Tarefa a iniciar: $MY_TASK"

curl -s -X PUT "$API_URL/api/cleaning/tasks/$MY_TASK/start" \
  -H "Authorization: Bearer $STAFF_TOKEN" | jq '{id, status}'
```

### Concluir tarefa com STAFF_TOKEN + observação

```bash
curl -s -X PUT "$API_URL/api/cleaning/tasks/$MY_TASK/complete" \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"notes":"Limpeza concluída. Frigobar reabastecido."}' \
  | jq '{id, status, notes}'
```

### Verificar que done do dia aparece em my-tasks

```bash
curl -s $API_URL/api/cleaning/my-tasks \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  | jq '[.[] | {roomNumber, status}]'
# A tarefa concluída deve aparecer com status "done" no final da lista
```

---

## 10. Tarifário — Temporadas

### Listar temporadas

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/seasons" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### Criar temporada — alta temporada verão

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/seasons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":            "Verão 2026",
    "type":            "peak",
    "startDate":       "2026-12-20",
    "endDate":         "2027-02-28",
    "priceMultiplier": 2.0
  }' | jq .
```

### Criar temporada — feriado Carnaval

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/seasons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":            "Carnaval 2026",
    "type":            "peak",
    "startDate":       "2026-02-12",
    "endDate":         "2026-02-18",
    "priceMultiplier": 2.5
  }' | jq .
```

**Salvar SEASON_ID:**

```bash
export SEASON_ID=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/seasons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Teste Temporada","type":"high","startDate":"2026-07-01","endDate":"2026-07-31","priceMultiplier":1.5}' \
  | jq -r '.id')

echo "Season ID: $SEASON_ID"
```

### Sobreposição de datas → 409

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/seasons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Duplicada","type":"high","startDate":"2026-07-15","endDate":"2026-08-15","priceMultiplier":1.3}'
# → {"error":"Sobreposição com temporada \"Teste Temporada\"","code":"DATE_OVERLAP"}
```

### Data inválida (30 de fevereiro) → 400

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/seasons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Inválida","type":"high","startDate":"2026-02-30","endDate":"2026-03-10","priceMultiplier":1.5}'
# → {"error":"startDate inválida (use YYYY-MM-DD)","code":"VALIDATION_ERROR"}
```

### Atualizar temporada

```bash
curl -s -X PUT "$API_URL/api/hotels/$HOTEL_ID/seasons/$SEASON_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":            "Julho Premium",
    "priceMultiplier": 1.8
  }' | jq .
```

### Deletar temporada

```bash
curl -s -X DELETE "$API_URL/api/hotels/$HOTEL_ID/seasons/$SEASON_ID" \
  -H "Authorization: Bearer $TOKEN"
# → {"success":true}
```

---

## 11. Tarifário — Multiplicadores por Dia da Semana

> **Chaves:** `"0"` = Domingo … `"6"` = Sábado. Valores entre 0.5 e 3.0.

### Ler multiplicadores atuais

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/weekday-multipliers" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {"0":1,"1":1,"2":1,"3":1,"4":1,"5":1,"6":1} (padrão do seed)
```

### Atualizar — fim de semana mais caro

```bash
curl -s -X PUT "$API_URL/api/hotels/$HOTEL_ID/weekday-multipliers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "0": 1.2,
    "1": 0.9,
    "2": 0.9,
    "3": 0.9,
    "4": 1.0,
    "5": 1.3,
    "6": 1.4
  }' | jq .
```

### Valor fora do range (max 3.0) → 400

```bash
curl -s -X PUT "$API_URL/api/hotels/$HOTEL_ID/weekday-multipliers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"0":1,"1":1,"2":1,"3":1,"4":1,"5":1,"6":5.0}'
# → {"error":"...","code":"VALIDATION_ERROR"}
```

---

## 12. Tarifário — Cálculo de Tarifa

> Pega o quarto do seed `101` para teste. Ajuste `ROOM_ID_101` para um quarto real do seu seed.

**Pegar roomId do quarto 101:**

```bash
export ROOM_101=$(curl -s "$API_URL/api/hotels/$HOTEL_ID/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.[] | select(.roomNumber=="101")][0].id')

echo "Room 101 ID: $ROOM_101"
```

### Calcular tarifa — período simples

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/tariff/calculate?roomId=$ROOM_101&checkin=2026-07-10&checkout=2026-07-14" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {totalPrice, totalNights, averageDailyRate, breakdown: [...por noite...]}
```

### Calcular tarifa — com temporada alta ativa

```bash
# Cria temporada que cobre o período
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/seasons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Teste Cálculo","type":"peak","startDate":"2026-07-08","endDate":"2026-07-20","priceMultiplier":2.0}' \
  > /dev/null

curl -s "$API_URL/api/hotels/$HOTEL_ID/tariff/calculate?roomId=$ROOM_101&checkin=2026-07-10&checkout=2026-07-14" \
  -H "Authorization: Bearer $TOKEN" | jq '{totalPrice, totalNights, averageDailyRate}'
# Total deve ser ~2x o valor sem temporada
```

### Parâmetros ausentes → 400

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/tariff/calculate?roomId=$ROOM_101" \
  -H "Authorization: Bearer $TOKEN"
# → {"error":"roomId, checkin e checkout são obrigatórios","code":"MISSING_PARAMS"}
```

### Datas invertidas → 400

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/tariff/calculate?roomId=$ROOM_101&checkin=2026-07-15&checkout=2026-07-10" \
  -H "Authorization: Bearer $TOKEN"
# → {"error":"Datas inválidas","code":"INVALID_DATES"}
```

---

## 13. FNRH — Ficha Nacional de Registro de Hóspedes

> **Pré-requisito:** ter um hóspede ($GUEST_ID) e uma hospedagem ($STAY_ID) criados (seções 5 e 6).
> Se o checkout já foi feito, crie nova hospedagem primeiro.

**Criar nova hospedagem para teste FNRH:**

```bash
export ROOM_FNRH=$(curl -s "$API_URL/api/hotels/$HOTEL_ID/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '[.[] | select(.status=="available")][0].id')

export STAY_FNRH=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/stays" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"guestId\":\"$GUEST_ID\",\"roomId\":\"$ROOM_FNRH\",\"numberOfNights\":2}" \
  | jq -r '.id')

echo "Stay FNRH: $STAY_FNRH"
```

### Criar FNRH — completo

```bash
curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/fnrh" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"guestId\":             \"$GUEST_ID\",
    \"stayId\":              \"$STAY_FNRH\",
    \"fullName\":            \"Carlos Pereira Lima\",
    \"documentType\":        \"RG\",
    \"documentNumber\":      \"MG1234567\",
    \"documentIssuer\":      \"SSP\",
    \"documentIssuerState\": \"MG\",
    \"birthDate\":           \"1985-06-20\",
    \"nationality\":         \"Brasileiro\",
    \"gender\":              \"M\",
    \"profession\":          \"Engenheiro\",
    \"addressStreet\":       \"Rua das Flores\",
    \"addressNumber\":       \"123\",
    \"addressComplement\":   \"Apto 45\",
    \"addressNeighborhood\": \"Centro\",
    \"addressCity\":         \"Belo Horizonte\",
    \"addressState\":        \"MG\",
    \"addressZipcode\":      \"30130-010\",
    \"addressCountry\":      \"Brasil\",
    \"arrivalDate\":         \"2026-05-24\",
    \"departureDate\":       \"2026-05-26\",
    \"transportMethod\":     \"aviao\",
    \"originCity\":          \"Belo Horizonte\",
    \"destinationCity\":     \"São Paulo\",
    \"purpose\":             \"negocios\"
  }" | jq .
```

**Salvar FNRH_ID:**

```bash
export FNRH_ID=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/fnrh" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"guestId\":\"$GUEST_ID\",\"stayId\":\"$STAY_FNRH\",
    \"fullName\":\"Carlos Pereira Lima\",\"documentType\":\"RG\",
    \"documentNumber\":\"MG9876543\",\"birthDate\":\"1985-06-20\",
    \"addressStreet\":\"Av. Principal\",\"addressCity\":\"Salvador\",
    \"addressState\":\"BA\",\"arrivalDate\":\"2026-05-24\",\"departureDate\":\"2026-05-26\"
  }" | jq -r '.id // .id')

echo "FNRH ID: $FNRH_ID"
```

### FNRH com CPF inválido → 400

```bash
export STAY2=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/stays" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"guestId\":\"$GUEST_ID\",\"roomId\":\"$(curl -s "$API_URL/api/hotels/$HOTEL_ID/rooms" \
    -H "Authorization: Bearer $TOKEN" | jq -r '[.[] | select(.status=="available")][0].id')\",\"numberOfNights\":1}" \
  | jq -r '.id')

curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/fnrh" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"guestId\":\"$GUEST_ID\",\"stayId\":\"$STAY2\",
    \"fullName\":\"Teste CPF\",\"documentType\":\"CPF\",
    \"documentNumber\":\"12345678901\",\"birthDate\":\"1990-01-01\",
    \"addressStreet\":\"Rua Teste\",\"addressCity\":\"Rio de Janeiro\",
    \"addressState\":\"RJ\",\"arrivalDate\":\"2026-05-24\",\"departureDate\":\"2026-05-26\"
  }"
# → {"error":"CPF inválido","code":"VALIDATION_ERROR"}
```

### Hóspede não corresponde à hospedagem → 422

```bash
# Criar outro hóspede
export OTHER_GUEST=$(curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/guests" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"cpf":"11144477735","name":"Outro Hospede"}' | jq -r '.id')

curl -s -X POST "$API_URL/api/hotels/$HOTEL_ID/fnrh" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"guestId\":\"$OTHER_GUEST\",\"stayId\":\"$STAY_FNRH\",
    \"fullName\":\"Outro Hóspede\",\"documentType\":\"RG\",
    \"documentNumber\":\"SP111111\",\"birthDate\":\"1990-01-01\",
    \"addressStreet\":\"Rua A\",\"addressCity\":\"SP\",
    \"addressState\":\"SP\",\"arrivalDate\":\"2026-05-24\",\"departureDate\":\"2026-05-26\"
  }"
# → {"error":"Hóspede não corresponde à hospedagem","code":"GUEST_STAY_MISMATCH"}
```

### Listar FNRHs

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/fnrh" \
  -H "Authorization: Bearer $TOKEN" | jq '{total, page, pages, data: [.data[] | {id, fullName, arrivalDate, exportedToSismatur}]}'
```

### Listar FNRHs — filtro por mês

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/fnrh?month=2026-05" \
  -H "Authorization: Bearer $TOKEN" | jq '{total, data: [.data[] | {fullName, arrivalDate}]}'
```

### Listar FNRHs — não exportados

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/fnrh?exported=false" \
  -H "Authorization: Bearer $TOKEN" | jq '.total'
```

### Editar FNRH (antes de exportar)

```bash
curl -s -X PUT "$API_URL/api/hotels/$HOTEL_ID/fnrh/$FNRH_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profession":   "Médico",
    "transportMethod": "carro"
  }' | jq '{fullName, profession, transportMethod}'
```

### Exportar FNRH para SISMATUR (.txt)

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/fnrh/export" \
  -H "Authorization: Bearer $TOKEN" \
  -o /tmp/fnrh_export.txt

echo "=== Arquivo exportado ==="
cat /tmp/fnrh_export.txt
echo ""
echo "=== Campos (pipe-separated) ==="
head -1 /tmp/fnrh_export.txt | tr '|' '\n' | cat -n
```

### Exportar por mês específico

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/fnrh/export?month=2026-05" \
  -H "Authorization: Bearer $TOKEN" \
  -o /tmp/fnrh_202605.txt

echo "Exportado: $(wc -l < /tmp/fnrh_202605.txt) registros"
```

### Editar FNRH já exportado → 400

```bash
# Após exportar, o FNRH fica bloqueado
curl -s -X PUT "$API_URL/api/hotels/$HOTEL_ID/fnrh/$FNRH_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profession":"Arquiteto"}'
# → {"error":"Registro já exportado não pode ser editado","code":"ALREADY_EXPORTED"}
```

---

## 14. Relatórios

### Ocupação

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/reports/occupancy" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {period, averageOccupancy, peakDay, dailyRates: [...]}
```

### Ocupação — filtro por período

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/reports/occupancy?from=2026-05-01&to=2026-05-31" \
  -H "Authorization: Bearer $TOKEN" | jq '{period, averageOccupancy}'
```

### Receita

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/reports/revenue" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {totalRevenue, revPAR, ADR, revenueByRoomType, dailyRevenue}
```

### Hóspedes

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/reports/guests" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {totalGuests, newGuests, returningGuests, topOrigins, purposeDistribution}
```

### Performance da equipe de limpeza

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/reports/staff-performance" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {period, staff: [{name, tasksCompleted, avgMinutes, approvalRate}]}
```

### Financeiro

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/reports/financial" \
  -H "Authorization: Bearer $TOKEN" | jq .
# → {grossRevenue, netRevenue, byPaymentMethod, projection}
```

---

## 15. Casos de Erro — Autenticação e Autorização

### Sem token → 401

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/dashboard/stats"
# → {"error":"Token ausente","code":"NO_TOKEN"}
```

### Token inválido → 401

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/dashboard/stats" \
  -H "Authorization: Bearer token_invalido_aqui"
# → {"error":"Token inválido","code":"INVALID_TOKEN"}
```

### Hotel de outro tenant → 403

```bash
curl -s "http://localhost:10000/api/hotels/00000000-0000-0000-0000-000000000000/dashboard/stats" \
  -H "Authorization: Bearer $TOKEN"
# → {"error":"Acesso negado","code":"FORBIDDEN"}
```

### Staff token em rota admin → 403

```bash
curl -s "$API_URL/api/hotels/$HOTEL_ID/guests" \
  -H "Authorization: Bearer $STAFF_TOKEN"
# Staff token passa verifyToken mas falha em enforceHotelOwnership se user não existir
# → 403 FORBIDDEN
```

### Task de outro hotel → 403

```bash
curl -s -X PUT "$API_URL/api/cleaning/tasks/00000000-0000-0000-0000-000000000000/start" \
  -H "Authorization: Bearer $TOKEN"
# → {"error":"Tarefa não encontrada","code":"NOT_FOUND"}
```

---

## Resumo dos Endpoints

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | `/health` | — | Health check |
| GET | `/api/status` | — | Status da API |
| POST | `/api/auth/login` | — | Login admin |
| POST | `/api/auth/refresh` | Cookie | Renovar sessão |
| POST | `/api/auth/logout` | Cookie | Logout |
| GET | `/api/hotels/:id/dashboard/stats` | Admin | Stats do hotel |
| GET | `/api/hotels/:id/rooms` | Admin | Listar quartos |
| POST | `/api/hotels/:id/guests` | Admin | Criar hóspede |
| GET | `/api/hotels/:id/guests` | Admin | Listar hóspedes |
| POST | `/api/hotels/:id/stays` | Admin | Check-in |
| GET | `/api/hotels/:id/stays/active/room/:roomId` | Admin | Hospedagem ativa |
| PUT | `/api/stays/:id/checkout` | Admin | Checkout |
| GET | `/api/hotels/:id/cleaning/staff` | Admin | Listar equipe |
| POST | `/api/hotels/:id/cleaning/staff` | Admin | Criar faxineira |
| PUT | `/api/hotels/:id/cleaning/staff/:id` | Admin | Editar faxineira |
| DELETE | `/api/hotels/:id/cleaning/staff/:id` | Admin | Desativar faxineira |
| GET | `/api/hotels/:id/cleaning/tasks` | Admin | Listar tarefas |
| POST | `/api/hotels/:id/cleaning/tasks` | Admin | Criar tarefa |
| PUT | `/api/cleaning/tasks/:id/start` | Admin/Staff | Iniciar tarefa |
| PUT | `/api/cleaning/tasks/:id/complete` | Admin/Staff | Concluir tarefa |
| PUT | `/api/cleaning/tasks/:id/inspect` | Admin | Inspecionar tarefa |
| POST | `/api/hotels/:id/cleaning/tasks/generate-daily` | Admin | Gerar tarefas do dia |
| POST | `/api/cleaning/auth/login` | — | Login faxineira (PIN) |
| GET | `/api/cleaning/my-tasks` | Staff | Tarefas da faxineira |
| GET | `/api/hotels/:id/seasons` | Admin | Listar temporadas |
| POST | `/api/hotels/:id/seasons` | Admin | Criar temporada |
| PUT | `/api/hotels/:id/seasons/:id` | Admin | Editar temporada |
| DELETE | `/api/hotels/:id/seasons/:id` | Admin | Deletar temporada |
| GET | `/api/hotels/:id/weekday-multipliers` | Admin | Ler multiplicadores |
| PUT | `/api/hotels/:id/weekday-multipliers` | Admin | Salvar multiplicadores |
| GET | `/api/hotels/:id/tariff/calculate` | Admin | Calcular tarifa |
| POST | `/api/hotels/:id/fnrh` | Admin | Criar FNRH |
| GET | `/api/hotels/:id/fnrh` | Admin | Listar FNRHs |
| PUT | `/api/hotels/:id/fnrh/:id` | Admin | Editar FNRH |
| GET | `/api/hotels/:id/fnrh/export` | Admin | Exportar SISMATUR |
| GET | `/api/hotels/:id/reports/occupancy` | Admin | Relatório de ocupação |
| GET | `/api/hotels/:id/reports/revenue` | Admin | Relatório de receita |
| GET | `/api/hotels/:id/reports/guests` | Admin | Relatório de hóspedes |
| GET | `/api/hotels/:id/reports/staff-performance` | Admin | Performance da equipe |
| GET | `/api/hotels/:id/reports/financial` | Admin | Relatório financeiro |
