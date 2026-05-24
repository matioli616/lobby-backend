# CHANGELOG — LOBBY Backend

---

## [3.0.0] — 2026-05-24 · Fase 1: Expansão Modular

### Novos módulos

#### Módulo Governança (Gestão de Limpeza)
- Cadastro de equipe de limpeza com PIN bcrypt (4–6 dígitos)
- Criação e atribuição de tarefas por quarto (prioridade, estimativa de tempo, observações)
- Máquina de estados completa: `pending → in_progress → done → inspected / inspection_failed`
- Inspeção pelo gerente com nota (1–5) e geração automática de tarefa de retrabalho se reprovada
- Geração automática de tarefas diárias (checkout + daily para quartos em hospedagem)
- App separado para faxineiras: PWA instalável no celular, funciona offline, login por PIN

#### Módulo FNRH — Ficha Nacional de Registro de Hóspedes
- Preenchimento digital da ficha obrigatória pela legislação hoteleira brasileira
- Validação completa: CPF com dígitos verificadores, UF, datas, correspondência hóspede/hospedagem
- Exportação automática no formato SISMATUR (`.txt` pipe-separated) exigido pela Polícia Federal
- Registros exportados ficam bloqueados para edição (conformidade legal)
- Filtros: por mês, por status de exportação

#### Módulo Tarifário Dinâmico
- Cadastro de temporadas com datas, tipo (low/regular/high/peak) e multiplicador de preço
- Multiplicadores por dia da semana (domingo a sábado, range 0.5–3.0)
- Quando múltiplas temporadas se sobrepõem, a de maior multiplicador tem prioridade
- Validação de sobreposição de datas por tipo de temporada
- Simulador de tarifa: cálculo dia a dia com breakdown detalhado (`seasonMultiplier × weekdayMultiplier × dailyRate`)

#### Módulo Relatórios (5 tipos)
- **Ocupação**: taxa diária, média do período, comparativo com período anterior, `averageOccupancy`
- **Receita**: total, ADR (diária média), RevPAR, breakdown por tipo de quarto e forma de pagamento
- **Hóspedes**: origem geográfica, faixa etária, motivo da viagem, duração média da estadia
- **Performance da equipe**: tarefas concluídas por faxineira, tempo médio, nota de inspeção, taxa de aprovação
- **Financeiro**: receita bruta, comparativo com período anterior, ADR, RevPAR
- Todos os relatórios: parâmetros `from`/`to` opcionais (default: últimos 30 dias)

#### App Faxineira (PWA)
- HTML/CSS/JS standalone (`cleaning-app.html`) servido pelo mesmo Express
- Service Worker (`sw.js`) para cache offline
- Manifest PWA (`manifest.json`) + ícones (192px, 512px) para instalação no celular
- Login por PIN de 6 dígitos (sem e-mail, sem senha difícil)
- Visualização de tarefas com quarto em destaque, prioridade colorida e estimativa de tempo
- Botões Iniciar / Concluir com campo de observação
- Atualização automática a cada 60 segundos

### Endpoints adicionados (28 novos)

**Governança:**
- `GET /api/hotels/:id/cleaning/staff`
- `POST /api/hotels/:id/cleaning/staff`
- `PUT /api/hotels/:id/cleaning/staff/:staffId`
- `DELETE /api/hotels/:id/cleaning/staff/:staffId`
- `GET /api/hotels/:id/cleaning/tasks`
- `POST /api/hotels/:id/cleaning/tasks`
- `PUT /api/cleaning/tasks/:id/start`
- `PUT /api/cleaning/tasks/:id/complete`
- `PUT /api/cleaning/tasks/:id/inspect`
- `POST /api/hotels/:id/cleaning/tasks/generate-daily`
- `POST /api/cleaning/auth/login`
- `GET /api/cleaning/my-tasks`

**Tarifário:**
- `GET /api/hotels/:id/seasons`
- `POST /api/hotels/:id/seasons`
- `PUT /api/hotels/:id/seasons/:seasonId`
- `DELETE /api/hotels/:id/seasons/:seasonId`
- `GET /api/hotels/:id/weekday-multipliers`
- `PUT /api/hotels/:id/weekday-multipliers`
- `GET /api/hotels/:id/tariff/calculate`

**FNRH:**
- `POST /api/hotels/:id/fnrh`
- `GET /api/hotels/:id/fnrh`
- `PUT /api/hotels/:id/fnrh/:recordId`
- `GET /api/hotels/:id/fnrh/export`

**Relatórios:**
- `GET /api/hotels/:id/reports/occupancy`
- `GET /api/hotels/:id/reports/revenue`
- `GET /api/hotels/:id/reports/guests`
- `GET /api/hotels/:id/reports/staff-performance`
- `GET /api/hotels/:id/reports/financial`

### Tabelas adicionadas (migrations.sql)

| Tabela | Descrição |
|--------|-----------|
| `cleaning_staff` | Equipe de limpeza com PIN bcrypt |
| `cleaning_tasks` | Tarefas de limpeza com state machine |
| `cleaning_inspections` | Inspeções com nota e resultado |
| `fnrh_records` | Fichas nacionais de registro de hóspedes |
| `seasons` | Temporadas com multiplicadores de preço |

### Correções de bugs (v3.0.0-patch)

- CPF com todos os dígitos iguais (`11111111111`) agora rejeitado corretamente
- Dashboard: campos renomeados para camelCase + métricas completas (`occupancyRate`, `revPAR`, etc.)
- `PUT /seasons/:id` retornava `INTERNAL_ERROR` — corrigido separando `SeasonSchemaBase` (ZodObject) de `SeasonSchema` (ZodEffects)
- `averageDailyRate` retornava `null` no cálculo de tarifa (campo tinha nome errado)
- Relatórios: `from`/`to` agora opcionais com default = últimos 30 dias
- `averageOccupancy` adicionado como alias de `occupancyRate` no relatório de ocupação

### Segurança (auditoria Fase 1)

- Corrigidas 15 vulnerabilidades identificadas em auditoria
- CORS dinâmico: servidor sempre permite próprio domínio (fix Render)
- Rate limiting por IP em login (20/15min)
- `enforceHotelOwnership` em todas as rotas hoteleiras (proteção IDOR)
- CSP via helmet com allowlist explícita
- Cookie httpOnly + sameSite:strict para sessão
- PINs de faxineiras nunca retornados nas respostas

---

## [2.0.0] — 2026-05-22 · Core PMS

### Módulos

- Auth (JWT, refresh, logout)
- Dashboard (stats em tempo real)
- Quartos (cadastro, status)
- Hóspedes (cadastro com validação CPF)
- Hospedagens (check-in, checkout, invoice)

### Infraestrutura

- Store in-memory com `Map` JavaScript (sem banco de dados)
- Seed data recreado a cada restart
- Frontend SPA (`index.html`) servido pelo mesmo Express
- Deploy no Render com anti-sleep via cron-job.org

---

## [1.0.0] — 2026-05-22 · MVP inicial

- Backend Express básico
- SQLite in-memory (substituído por Map puro na v2)
- Endpoints básicos de auth e quartos

---

## Pendente — Fase 2

### Channel Manager
- Integração com Booking.com (API de disponibilidade e reservas)
- Integração com Decolar / Expedia
- Atualização automática de disponibilidade via webhook
- Mapeamento de tarifas entre canais

### Motor de Reservas (site do hotel)
- Widget de disponibilidade embeddable
- Checkout de reserva direta (sem comissão de OTA)
- Confirmação automática por e-mail
- Gestão de lista de espera

### Fiscal / NFS-e
- Integração com prefeituras para emissão de NFS-e
- Nota fiscal automática no checkout
- Relatório fiscal mensal

### Integrações Operacionais
- Integração com sistemas de cartão-chave (Assa Abloy, Dormakaba)
- Controle de minibar / frigobar por quarto
- Comunicação com hóspede via WhatsApp (chegada, checkout, NPS)

### Multihotel / Enterprise
- Dashboard consolidado multi-unidade
- Gestão centralizada de equipes (faxineiras em múltiplos hotéis)
- Tarifário sincronizado entre unidades

### Financeiro Avançado
- Contas a receber e a pagar
- Conciliação bancária
- Projeção de receita com base em reservas futuras
- Comissões de agências

### Analytics Avançado
- Heatmap de ocupação por mês/tipo de quarto
- Análise de canal de origem (direto vs OTA vs agência)
- Predição de demanda com base em histórico
- Export CSV / PDF de todos os relatórios
