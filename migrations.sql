
-- ============================================================
-- LOBBY v3 — MIGRATIONS
-- Executar manualmente no Supabase SQL Editor
-- ============================================================

-- ============================================================
-- MÓDULO 1: GOVERNANÇA
-- ============================================================

CREATE TABLE IF NOT EXISTS cleaning_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "hotelId" UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(15),
  pin VARCHAR(6) NOT NULL,
  "isActive" BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cleaning_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "hotelId" UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  "roomId" UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  "assignedTo" UUID REFERENCES cleaning_staff(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','inspected')),
  priority VARCHAR(10) DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  "estimatedMinutes" INT DEFAULT 30,
  "actualMinutes" INT,
  notes TEXT,
  "startedAt" TIMESTAMP,
  "completedAt" TIMESTAMP,
  "inspectedAt" TIMESTAMP,
  "inspectedBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cleaning_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskId" UUID NOT NULL REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  score INT CHECK (score BETWEEN 0 AND 10),
  notes TEXT,
  passed BOOLEAN,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

-- Índices: GOVERNANÇA
CREATE INDEX IF NOT EXISTS idx_cleaning_staff_hotel ON cleaning_staff("hotelId");
CREATE INDEX IF NOT EXISTS idx_cleaning_staff_active ON cleaning_staff("hotelId","isActive");
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_hotel ON cleaning_tasks("hotelId");
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_room ON cleaning_tasks("roomId");
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_status ON cleaning_tasks("hotelId",status);
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_assigned ON cleaning_tasks("assignedTo");
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_created ON cleaning_tasks("createdAt");
CREATE INDEX IF NOT EXISTS idx_cleaning_inspections_task ON cleaning_inspections("taskId");

-- ============================================================
-- MÓDULO 2: FNRH
-- ============================================================

CREATE TABLE IF NOT EXISTS fnrh_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "hotelId" UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  "guestId" UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  "stayId" UUID NOT NULL REFERENCES stays(id) ON DELETE CASCADE,
  "fullName" VARCHAR(200) NOT NULL,
  "documentType" VARCHAR(20) NOT NULL CHECK ("documentType" IN ('CPF','RG','CNH','Passaporte','RNE','Outro')),
  "documentNumber" VARCHAR(30) NOT NULL,
  "documentIssuer" VARCHAR(50),
  "documentIssuerState" VARCHAR(2),
  "birthDate" DATE NOT NULL,
  "nationality" VARCHAR(50) NOT NULL DEFAULT 'Brasileiro',
  gender VARCHAR(1) CHECK (gender IN ('M','F','O')),
  profession VARCHAR(100),
  "addressStreet" VARCHAR(200) NOT NULL,
  "addressNumber" VARCHAR(20),
  "addressComplement" VARCHAR(100),
  "addressNeighborhood" VARCHAR(100),
  "addressCity" VARCHAR(100) NOT NULL,
  "addressState" VARCHAR(2) NOT NULL,
  "addressZipcode" VARCHAR(10),
  "addressCountry" VARCHAR(50) DEFAULT 'Brasil',
  "arrivalDate" DATE NOT NULL,
  "departureDate" DATE NOT NULL,
  "transportMethod" VARCHAR(20) CHECK ("transportMethod" IN ('carro','onibus','aviao','trem','barco','outro')),
  "transportLicense" VARCHAR(20),
  "originCity" VARCHAR(100),
  "destinationCity" VARCHAR(100),
  purpose VARCHAR(20) CHECK (purpose IN ('turismo','negocios','evento','saude','estudo','outro')),
  "exportedToSismatur" BOOLEAN DEFAULT false,
  "exportedAt" TIMESTAMP,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW()
);

-- Índices: FNRH
CREATE INDEX IF NOT EXISTS idx_fnrh_hotel ON fnrh_records("hotelId");
CREATE INDEX IF NOT EXISTS idx_fnrh_guest ON fnrh_records("guestId");
CREATE INDEX IF NOT EXISTS idx_fnrh_stay ON fnrh_records("stayId");
CREATE INDEX IF NOT EXISTS idx_fnrh_arrival ON fnrh_records("hotelId","arrivalDate");
CREATE INDEX IF NOT EXISTS idx_fnrh_exported ON fnrh_records("hotelId","exportedToSismatur");
CREATE INDEX IF NOT EXISTS idx_fnrh_document ON fnrh_records("documentNumber");

-- ============================================================
-- MÓDULO 3: TARIFÁRIO DINÂMICO
-- ============================================================

ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS season VARCHAR(20) DEFAULT 'regular';
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS "dayOfWeek" INT CHECK ("dayOfWeek" BETWEEN 0 AND 6);
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS "validFrom" DATE;
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS "validUntil" DATE;
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS "priceMultiplier" DECIMAL(5,2) DEFAULT 1.00;

CREATE TABLE IF NOT EXISTS seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "hotelId" UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('alta','baixa','feriado','evento','regular')),
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "priceMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  CONSTRAINT chk_season_dates CHECK ("endDate" >= "startDate")
);

-- Índices: TARIFÁRIO
CREATE INDEX IF NOT EXISTS idx_seasons_hotel ON seasons("hotelId");
CREATE INDEX IF NOT EXISTS idx_seasons_dates ON seasons("hotelId","startDate","endDate");
CREATE INDEX IF NOT EXISTS idx_tariffs_hotel_season ON tariffs("hotelId",season);
CREATE INDEX IF NOT EXISTS idx_tariffs_dates ON tariffs("validFrom","validUntil");

-- ============================================================
-- MÓDULO 4: RELATÓRIOS
-- (sem tabelas novas — usa as existentes com queries agregadas)
-- ============================================================

-- View auxiliar: receita diária
CREATE OR REPLACE VIEW vw_daily_revenue AS
SELECT
  i."hotelId",
  DATE(i."createdAt") AS day,
  COUNT(*) AS total_checkouts,
  SUM(i.total) AS revenue
FROM invoices i
WHERE i.status = 'paid'
GROUP BY i."hotelId", DATE(i."createdAt");

-- View auxiliar: ocupação diária
CREATE OR REPLACE VIEW vw_daily_occupancy AS
SELECT
  s."hotelId",
  DATE(s."checkinTime") AS day,
  COUNT(*) AS checkins,
  COUNT(s."checkoutTime") AS checkouts,
  COUNT(*) FILTER (WHERE s."checkoutTime" IS NULL) AS active_stays
FROM stays s
GROUP BY s."hotelId", DATE(s."checkinTime");

-- ============================================================
-- SEGURANÇA: RLS + exec_sql (aplicado 2026-05-28)
-- ============================================================

-- Habilita RLS nas tabelas que estavam abertas.
-- Sem políticas = deny-all via PostgREST. Backend usa service_role (bypassa RLS).
ALTER TABLE public.cleaning_staff       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_tasks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleaning_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fnrh_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons              ENABLE ROW LEVEL SECURITY;

-- Revoga exec_sql de PUBLIC (anon/authenticated não devem chamar SQL arbitrário via RPC).
REVOKE EXECUTE ON FUNCTION public.exec_sql(text, jsonb) FROM PUBLIC;

-- ============================================================
-- NFS-e — colunas adicionadas na tabela invoices (2026-05-28)
-- ============================================================
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS nfse_id     TEXT,
  ADD COLUMN IF NOT EXISTS nfse_numero TEXT,
  ADD COLUMN IF NOT EXISTS nfse_url    TEXT,
  ADD COLUMN IF NOT EXISTS nfse_status TEXT;

-- Variáveis de ambiente necessárias no servidor:
--   FOCUSNFE_TOKEN            — token da API Focus NFe (sandbox: cadastro em focusnfe.com.br)
--   FOCUSNFE_ENV              — 'sandbox' (padrão) ou 'production'
--   HOTEL_CNPJ                — CNPJ do hotel (apenas dígitos)
--   HOTEL_INSCRICAO_MUNICIPAL — inscrição municipal do hotel
--   HOTEL_MUNICIPIO_CODIGO    — código IBGE do município (padrão: 3550308 = São Paulo)
--   HOTEL_CNAE                — CNAE do serviço (padrão: 5590601 = hospedagem)
