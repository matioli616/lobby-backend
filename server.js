require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { randomUUID } = require('crypto');
const db = require('./db');

const NODE_ENV = process.env.NODE_ENV || 'development';

// ============ NFS-e (Focus NFe) ============
const FOCUSNFE_TOKEN = process.env.FOCUSNFE_TOKEN || '';
const FOCUSNFE_BASE  = process.env.FOCUSNFE_ENV === 'production'
  ? 'https://api.focusnfe.com.br'
  : 'https://homologacao.focusnfe.com.br';

async function emitirNfse(invoiceId, stay, guest, roomNumber) {
  if (!FOCUSNFE_TOKEN) return;
  const ref  = `lobby-${invoiceId}`;
  const auth = Buffer.from(`${FOCUSNFE_TOKEN}:`).toString('base64');
  const total = stay.numberOfNights * stay.dailyRate + (stay.extras || 0);
  const body = {
    data_emissao: new Date().toISOString().split('T')[0],
    prestador: {
      cnpj:                  (process.env.HOTEL_CNPJ || '18765432000100').replace(/\D/g, ''),
      inscricao_municipal:   process.env.HOTEL_INSCRICAO_MUNICIPAL || '12345',
      codigo_municipio:      process.env.HOTEL_MUNICIPIO_CODIGO    || '3550308',
    },
    tomador: {
      cpf:          (guest.cpf || '').replace(/\D/g, '') || undefined,
      razao_social: guest.name,
      email:        guest.email || undefined,
    },
    items: [{
      discriminacao: `Hospedagem ${stay.numberOfNights} noite(s) - Quarto ${roomNumber}`,
      cnae:          process.env.HOTEL_CNAE || '5590601',
      valor_unitario: total,
      quantidade:    1,
    }],
  };
  try {
    const resp = await fetch(`${FOCUSNFE_BASE}/v2/nfse?ref=${ref}`, {
      method:  'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await resp.json();
    await db.update('invoices', invoiceId, {
      nfseId:     ref,
      nfseStatus: data.status || 'processando',
      nfseNumero: data.numero    || null,
      nfseUrl:    data.url       || null,
    });
  } catch (err) {
    console.error('[NFS-e] Erro ao emitir:', err.message);
    await db.update('invoices', invoiceId, { nfseId: ref, nfseStatus: 'erro' }).catch(() => {});
  }
}

async function consultarNfse(nfseId) {
  if (!FOCUSNFE_TOKEN || !nfseId) return null;
  const auth = Buffer.from(`${FOCUSNFE_TOKEN}:`).toString('base64');
  try {
    const resp = await fetch(`${FOCUSNFE_BASE}/v2/nfse/${nfseId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    return await resp.json();
  } catch { return null; }
}

const JWT_SECRET = process.env.JWT_SECRET || (
  NODE_ENV === 'production'
    ? (() => { throw new Error('JWT_SECRET não definido — obrigatório em produção'); })()
    : 'lobby-demo-secret-2026'
);

const app = express();
app.set('trust proxy', 1);

// ============ SECURITY MIDDLEWARE ============
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:10000')
  .split(',').map(o => o.trim());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Sem origin = mesma origem ou server-to-server: não precisa de headers CORS
  if (!origin) {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }
  const serverOrigin = `${req.protocol}://${req.get('host')}`;
  const allowed = origin === serverOrigin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*');
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }
  console.log('CORS bloqueado:', origin);
  res.status(403).json({ error: 'Origem não permitida', code: 'CORS_ERROR' });
});

app.use(express.json({ limit: '100kb' }));

// ============ RATE LIMITING ============
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,
  message: 'Muitas tentativas de login. Tente novamente em 15 minutos.' });

// ============ SEED DATA ============
const HOTEL_ID = 'a1b2c3d4-e5f6-4890-a123-456789abcdef';
const USER_ID  = 'b1c2d3e4-f5a6-4890-b456-789abcdef012';
const BCRYPT_ROUNDS = 10;

async function seedDatabase() {
  const [hotelExists] = await db.q('SELECT id FROM hotels WHERE id = $1', [HOTEL_ID]);
  if (hotelExists) {
    console.log('✅ Banco já inicializado — seed pulado');
    return;
  }
  console.log('🌱 Inserindo dados demo no Supabase...');

  // Hotel (usa supabase-js — weekdaymultipliers é JSONB, não pode ir via exec_sql params)
  await db.supabase.from('hotels').upsert(
    { id: HOTEL_ID, name: 'Hotel Demo LOBBY', slug: 'demo', weekdaymultipliers: {'0':1.0,'1':1.0,'2':1.0,'3':1.0,'4':1.0,'5':1.2,'6':1.3} },
    { onConflict: 'id', ignoreDuplicates: true }
  );

  // User (admin) — usa supabase-js upsert: bcrypt hash tem '$2b$10$...' que quebra exec_sql
  const adminPwHash = await bcrypt.hash('demo123', BCRYPT_ROUNDS);
  await db.supabase.from('users').upsert(
    { id: USER_ID, hotelid: HOTEL_ID, email: 'admin@demo.com', password_hash: adminPwHash, name: 'Admin Demo', role: 'admin', isactive: true },
    { onConflict: 'email' }
  );

  // Quartos
  const roomDefs = [
    ['101','standard',2,150], ['102','standard',2,150], ['103','standard',2,150],
    ['201','double',  4,250], ['202','double',  4,250],
    ['301','suite',   2,450], ['302','suite',   2,450],
    ['401','standard',2,150], ['402','double',  4,250], ['501','suite',2,500],
  ];
  const roomIds = {};
  for (const [num, type, cap, rate] of roomDefs) {
    const id = randomUUID();
    roomIds[num] = id;
    await db.q(
      `INSERT INTO rooms (id, hotelid, roomnumber, roomtype, capacity, dailyrate, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'available') ON CONFLICT DO NOTHING`,
      [id, HOTEL_ID, parseInt(num), type, cap, rate]
    );
  }

  // Hóspedes
  const guestDefs = [
    ['12345678901', 'João Silva',    'joao@email.com',  '11999990001', 3, 2100, 42],
    ['98765432100', 'Maria Oliveira','maria@email.com', '11999990002', 5, 4500, 75],
    ['11122233344', 'Carlos Santos', 'carlos@email.com','11999990003', 1,  450,  8],
  ];
  let joaoId;
  const guestIds = [];
  for (const [cpf, name, email, phone, totalStays, totalSpent, vipScore] of guestDefs) {
    const id = randomUUID();
    guestIds.push(id);
    if (cpf === '12345678901') joaoId = id;
    await db.q(
      `INSERT INTO guests (id, hotelid, cpf, name, email, phone, totalstays, totalspent, vipscore)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [id, HOTEL_ID, cpf, name, email, phone, totalStays, totalSpent, vipScore]
    );
  }

  // Hospedagem ativa (João no quarto 201)
  const activeStayId = randomUUID();
  await db.q(
    `INSERT INTO stays (id, hotelid, guestid, roomid, numberofnights, dailyrate, checkintime, extras, paymentstatus)
     VALUES ($1, $2, $3, $4, 2, 250, $5, 0, 'pending') ON CONFLICT DO NOTHING`,
    [activeStayId, HOTEL_ID, joaoId, roomIds['201'], new Date(Date.now() - 86400000)]
  );
  await db.q(`UPDATE rooms SET status = 'occupied' WHERE id = $1`, [roomIds['201']]);

  // Faxineiras — usa db.insert (supabase-js): bcrypt hash não pode ir via exec_sql
  const staffDefs = [
    ['Ana Lima',      '11988880001', '123456'],
    ['Beatriz Costa', '11988880002', '567890'],
    ['Carla Mendes',  '11988880003', '901234'],
  ];
  const staffIds = [];
  for (const [name, phone, pin] of staffDefs) {
    const id = randomUUID();
    staffIds.push(id);
    const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    await db.supabase.from('cleaning_staff')
      .upsert({ id, hotelid: HOTEL_ID, name, phone, pin: pinHash, isactive: true }, { onConflict: 'id', ignoreDuplicates: true });
  }

  // Tarefas demo
  const taskSeeds = [
    [roomIds['101'], staffIds[0], 'pending',    'normal', 30],
    [roomIds['102'], staffIds[1], 'in_progress','high',   45],
    [roomIds['103'], staffIds[2], 'done',       'normal', 25],
    [roomIds['301'], staffIds[0], 'pending',    'urgent', 60],
  ];
  for (const [roomId, assignedTo, status, priority, estimatedMinutes] of taskSeeds) {
    const startedAt   = status !== 'pending'  ? new Date(Date.now() - 1800000) : null;
    const completedAt = status === 'done'      ? new Date(Date.now() -  900000) : null;
    const actualMinutes = status === 'done'    ? 28 : null;
    await db.q(
      `INSERT INTO cleaning_tasks (id, hotelid, roomid, assignedto, status, priority, estimatedminutes, actualminutes, startedat, completedat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [randomUUID(), HOTEL_ID, roomId, assignedTo, status, priority, estimatedMinutes, actualMinutes, startedAt, completedAt]
    );
  }

  // Temporadas
  const seasonSeeds = [
    ['Réveillon',       'peak',    '2026-12-26','2027-01-02', 2.50],
    ['Carnaval 2027',   'peak',    '2027-02-26','2027-03-05', 2.20],
    ['Alta Temporada',  'high',    '2026-12-01','2027-02-28', 1.50],
    ['Baixa Temporada', 'low',     '2026-04-01','2026-06-30', 0.80],
  ];
  for (const [name, type, startdate, enddate, pricemultiplier] of seasonSeeds) {
    await db.q(
      `INSERT INTO seasons (id, hotelid, name, type, startdate, enddate, pricemultiplier)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [randomUUID(), HOTEL_ID, name, type, startdate, enddate, pricemultiplier]
    );
  }

  // Hospedagens concluídas + invoices para relatórios
  const D = (daysAgo) => new Date(Date.now() - daysAgo * 86400000);
  const completedStays = [
    ['101', 0, 18, 15, 3, 150, 'pix'],
    ['102', 1,  5,  2, 3, 150, 'credit'],
    ['301', 2, 25, 20, 5, 450, 'credit'],
    ['302', 0, 12,  9, 3, 450, 'debit'],
    ['401', 1, 30, 27, 3, 150, 'cash'],
    ['402', 2,  8,  6, 2, 250, 'pix'],
    ['103', 0, 40, 37, 3, 150, 'credit'],
    ['501', 1, 45, 40, 5, 500, 'credit'],
  ];
  for (const [roomKey, gIdx, cin, cout, nights, rate, pay] of completedStays) {
    const sid     = randomUUID();
    const guestId = guestIds[gIdx] || guestIds[0];
    await db.q(
      `INSERT INTO stays (id, hotelid, guestid, roomid, numberofnights, dailyrate, checkintime, checkouttime, extras, paymentmethod, paymentstatus)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, 'paid') ON CONFLICT DO NOTHING`,
      [sid, HOTEL_ID, guestId, roomIds[roomKey], nights, rate, D(cin), D(cout), pay]
    );
    await db.q(
      `INSERT INTO invoices (id, hotelid, stayid, totalvalue, paymentmethod, status, createdat)
       VALUES ($1, $2, $3, $4, $5, 'paid', $6) ON CONFLICT DO NOTHING`,
      [randomUUID(), HOTEL_ID, sid, nights * rate, pay, D(cout)]
    );
  }

  // FNRH demo
  await db.q(
    `INSERT INTO fnrh_records
       (id, hotelid, guestid, stayid, fullname, documenttype, documentnumber,
        documentissuer, documentissuerstate, birthdate, nationality, gender, profession,
        addressstreet, addressnumber, addresscity, addressstate, addresszipcode, addresscountry,
        arrivaldate, departuredate, transportmethod, transportlicense,
        origincity, destinationcity, purpose, exportedtosismatur)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,false)
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(), HOTEL_ID, joaoId, activeStayId,
      'João Silva', 'CPF', '12345678901', 'SSP', 'SP',
      '1985-03-15', 'Brasileiro', 'M', 'Engenheiro',
      'Rua das Flores', '123', 'São Paulo', 'SP', '01310-100', 'Brasil',
      new Date(Date.now() - 86400000).toISOString().split('T')[0],
      new Date(Date.now() + 86400000).toISOString().split('T')[0],
      'carro', 'ABC-1234', 'São Paulo', 'Rio de Janeiro', 'turismo',
    ]
  );

  console.log('✅ Demo database inicializado — login: admin@demo.com / demo123');
}

// ============ HEALTH CHECK ============
app.get('/health', async (req, res) => {
  try {
    await db.q('SELECT 1 AS ok', []);
    res.json({ status: 'ok', mode: 'supabase', db: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', mode: 'supabase', db: 'error', timestamp: new Date().toISOString() });
  }
});

// ============ FUNÇÕES UTILITÁRIAS ============
function removeAccents(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

function validateCPFDoc(cpf) {
  cpf = cpf.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let d1 = (sum * 10) % 11; if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  let d2 = (sum * 10) % 11; if (d2 === 10) d2 = 0;
  return d2 === parseInt(cpf[10]);
}

function fmtDate(dateStr) {
  return dateStr ? dateStr.replace(/-/g, '') : '';
}

const VALID_UFS = new Set([
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
  'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
]);

// ============ VALIDATION SCHEMAS ============
const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });
const GuestSchema = z.object({
  cpf:   z.string().regex(/^\d{11}$/).refine(validateCPFDoc, 'CPF inválido'),
  name:  z.string().min(3).max(120),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
});
const StaySchema = z.object({
  guestId: z.string().uuid(),
  roomId:  z.string().uuid(),
  numberOfNights: z.number().min(1).max(365),
});
const CleaningStaffSchema = z.object({
  name:     z.string().min(3).max(120),
  pin:      z.string().regex(/^\d{4,6}$/, 'PIN deve ter 4–6 dígitos'),
  phone:    z.string().regex(/^[\d\s()\-+]{10,15}$/).optional().nullable(),
  isActive: z.boolean().optional(),
});
const CleaningTaskSchema = z.object({
  roomId:           z.string().uuid(),
  assignedTo:       z.string().uuid().optional().nullable(),
  priority:         z.enum(['low','normal','high','urgent']).default('normal'),
  estimatedMinutes: z.number().min(5).max(480).default(30),
  notes:            z.string().max(500).optional().nullable(),
});
const CompleteTaskSchema = z.object({
  actualMinutes: z.number().min(1).max(480).optional().nullable(),
  notes:         z.string().max(500).optional().nullable(),
});
const InspectTaskSchema = z.object({
  score:  z.number().min(1).max(5),
  notes:  z.string().max(500).optional().nullable(),
  passed: z.boolean(),
});
const StaffLoginSchema = z.object({
  staffId: z.string().uuid(),
  pin:     z.string().regex(/^\d{4,6}$/),
});
const PaymentMethodEnum = z.enum(['cash','credit','debit','pix']);
const CheckoutBodySchema = z.object({
  paymentMethod: PaymentMethodEnum,
  paymentStatus: z.enum(['paid','pending']).optional().default('paid'),
});

function isCalendarDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T12:00:00');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== str) return false;
  const year = d.getFullYear();
  return year >= 2000 && year <= 2100;
}

function diffDays(from, to) {
  return Math.round((new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00')) / 86400000);
}

async function isRoomAvailable(hotelId, roomId, checkinDate, checkoutDate, excludeResId) {
  const [conflict] = await db.q(
    `SELECT 1 FROM reservations
     WHERE hotelid = $1 AND roomid = $2 AND status = 'confirmed'
     AND checkindate < $4::date AND checkoutdate > $3::date
     AND ($5 IS NULL OR id::text != $5)
     LIMIT 1`,
    [hotelId, roomId, checkinDate, checkoutDate, excludeResId || null]
  );
  if (conflict) return false;
  const [busyStay] = await db.q(
    `SELECT 1 FROM stays
     WHERE roomid = $1 AND checkouttime IS NULL
     AND (checkintime::date + numberofnights * INTERVAL '1 day')::date > $2::date
     LIMIT 1`,
    [roomId, checkinDate]
  );
  return !busyStay;
}

const SeasonSchemaBase = z.object({
  name:            z.string().min(2).max(100),
  type:            z.enum(['low','regular','high','peak']),
  startDate:       z.string().refine(isCalendarDate, 'startDate inválida (use YYYY-MM-DD)'),
  endDate:         z.string().refine(isCalendarDate, 'endDate inválida (use YYYY-MM-DD)'),
  priceMultiplier: z.number().min(0.5).max(3.0),
});
const SeasonSchema = SeasonSchemaBase.refine(
  d => d.endDate > d.startDate,
  { message: 'endDate deve ser após startDate', path: ['endDate'] }
);
const WeekdaySchema = z.object({
  '0': z.number().min(0.5).max(3.0), '1': z.number().min(0.5).max(3.0),
  '2': z.number().min(0.5).max(3.0), '3': z.number().min(0.5).max(3.0),
  '4': z.number().min(0.5).max(3.0), '5': z.number().min(0.5).max(3.0),
  '6': z.number().min(0.5).max(3.0),
});
const ReservationSchema = z.object({
  guestId:         z.string().uuid(),
  roomId:          z.string().uuid(),
  checkinDate:     z.string().refine(isCalendarDate, 'checkinDate inválida (use YYYY-MM-DD)'),
  checkoutDate:    z.string().refine(isCalendarDate, 'checkoutDate inválida (use YYYY-MM-DD)'),
  numberOfGuests:  z.number().min(1).max(20).default(1),
  specialRequests: z.string().max(500).optional().nullable(),
}).refine(d => d.checkoutDate > d.checkinDate, {
  message: 'checkoutDate deve ser após checkinDate', path: ['checkoutDate'],
});

const FNRHObjectBase = z.object({
  guestId:             z.string().uuid(),
  stayId:              z.string().uuid(),
  fullName:            z.string().min(3).max(200),
  documentType:        z.enum(['CPF','RG','PASSAPORTE']),
  documentNumber:      z.string().min(5).max(30),
  documentIssuer:      z.string().max(50).optional().nullable(),
  documentIssuerState: z.string().length(2).optional().nullable(),
  birthDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nationality:         z.string().min(2).max(50).default('Brasileiro'),
  gender:              z.enum(['M','F','O']).optional().nullable(),
  profession:          z.string().max(100).optional().nullable(),
  addressStreet:       z.string().min(3).max(200),
  addressNumber:       z.string().max(20).optional().nullable(),
  addressComplement:   z.string().max(100).optional().nullable(),
  addressNeighborhood: z.string().max(100).optional().nullable(),
  addressCity:         z.string().min(2).max(100),
  addressState:        z.string().length(2).toUpperCase(),
  addressZipcode:      z.string().max(10).optional().nullable(),
  addressCountry:      z.string().max(50).default('Brasil'),
  arrivalDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departureDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transportMethod:     z.enum(['carro','onibus','aviao','trem','barco','outro']).optional().nullable(),
  transportLicense:    z.string().max(20).optional().nullable(),
  originCity:          z.string().max(100).optional().nullable(),
  destinationCity:     z.string().max(100).optional().nullable(),
  purpose:             z.enum(['turismo','negocios','evento','saude','estudo','outro']).optional().nullable(),
});

function fnrhRefine(d, ctx) {
  if (d.documentType === 'CPF' && d.documentNumber && !validateCPFDoc(d.documentNumber))
    ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'CPF inválido' });
  if (d.birthDate && new Date(d.birthDate) > new Date())
    ctx.addIssue({ code: 'custom', path: ['birthDate'], message: 'Data de nascimento não pode ser futura' });
  if (d.arrivalDate && d.departureDate && d.arrivalDate >= d.departureDate)
    ctx.addIssue({ code: 'custom', path: ['departureDate'], message: 'Data de saída deve ser após a chegada' });
  if (d.addressState && !VALID_UFS.has(d.addressState.toUpperCase()))
    ctx.addIssue({ code: 'custom', path: ['addressState'], message: 'UF inválida' });
}

const FNRHSchema        = FNRHObjectBase.superRefine(fnrhRefine);
const FNRHPartialSchema = FNRHObjectBase.partial().superRefine(fnrhRefine);

// ============ MIDDLEWARE ============
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token ausente', code: 'NO_TOKEN' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    res.status(401).json({ error: 'Token inválido', code });
  }
}

function verifyStaffToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token ausente', code: 'NO_TOKEN' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'cleaning_staff')
      return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    req.staff = decoded;
    next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    res.status(401).json({ error: 'Token inválido', code });
  }
}

// hotelId já vem no JWT — sem necessidade de DB lookup extra
function enforceHotelOwnership(req, res, next) {
  if (req.user.hotelId !== req.params.hotelId)
    return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
  next();
}

// ============ ROUTES: AUTH ============
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const [row] = await db.q('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
    const user  = db.FROM_DB.users(row ?? null);
    const valid = user && await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Email ou senha inválidos', code: 'INVALID_CREDENTIALS' });
    if (!user.isActive) return res.status(403).json({ error: 'Conta desativada', code: 'INACTIVE_ACCOUNT' });
    const token = jwt.sign({ id: user.id, email: user.email, hotelId: user.hotelId }, JWT_SECRET, { expiresIn: '8h' });
    const { password: _, ...safeUser } = user;
    res.cookie('lobby_token', token, {
      httpOnly: true, sameSite: 'strict',
      secure: NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ token, user: safeUser });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao fazer login', code: 'INTERNAL_ERROR' });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  const raw   = req.headers.cookie || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith('lobby_token='));
  if (!match) return res.status(401).json({ error: 'Sessão expirada', code: 'NO_COOKIE' });
  const cookieToken = match.split('=')[1];
  try {
    const decoded = jwt.verify(cookieToken, JWT_SECRET);
    const user    = await db.getById('users', decoded.id);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado', code: 'USER_NOT_FOUND' });
    if (!user.isActive) return res.status(403).json({ error: 'Conta desativada', code: 'INACTIVE_ACCOUNT' });
    const newToken = jwt.sign({ id: user.id, email: user.email, hotelId: user.hotelId }, JWT_SECRET, { expiresIn: '8h' });
    const { password: _, ...safeUser } = user;
    res.cookie('lobby_token', newToken, {
      httpOnly: true, sameSite: 'strict',
      secure: NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ token: newToken, user: safeUser });
  } catch {
    res.clearCookie('lobby_token');
    res.status(401).json({ error: 'Sessão expirada', code: 'TOKEN_EXPIRED' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('lobby_token');
  res.json({ success: true });
});

// ============ ROUTES: DASHBOARD ============
app.get('/api/hotels/:hotelId/dashboard/stats', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const today        = new Date().toDateString();
    const thirtyAgo    = new Date(Date.now() - 30 * 86400000);

    const [rooms, stays, invoices] = await Promise.all([
      db.q('SELECT status FROM rooms WHERE hotelid = $1', [hotelId]),
      db.q('SELECT checkintime, checkouttime FROM stays WHERE hotelid = $1', [hotelId]),
      db.q(`SELECT totalvalue, createdat FROM invoices WHERE hotelid = $1 AND status = 'paid'`, [hotelId]),
    ]);
    const [guestCount] = await db.q('SELECT COUNT(*)::int AS cnt FROM guests WHERE hotelid = $1', [hotelId]);

    const totalRooms     = rooms.length;
    const occupiedRooms  = rooms.filter(r => r.status === 'occupied').length;
    const cleaningRooms  = rooms.filter(r => r.status === 'cleaning').length;
    const availableRooms = rooms.filter(r => r.status === 'available').length;
    const occupancyRate  = totalRooms > 0 ? parseFloat((occupiedRooms / totalRooms * 100).toFixed(1)) : 0;

    const invJS = invoices.map(i => ({ total: parseFloat(i.totalvalue), createdAt: new Date(i.createdat) }));
    const revenueThisMonth = invJS.filter(i => i.createdAt >= thirtyAgo).reduce((s, i) => s + i.total, 0);
    const revenueToday     = invJS.filter(i => i.createdAt.toDateString() === today).reduce((s, i) => s + i.total, 0);
    const revPAR = totalRooms > 0 ? parseFloat((revenueThisMonth / (totalRooms * 30)).toFixed(2)) : 0;

    res.json({
      totalRooms, occupiedRooms, availableRooms, cleaningRooms, occupancyRate,
      activeStays:    stays.filter(s => !s.checkouttime).length,
      totalGuests:    guestCount.cnt,
      checkinsToday:  stays.filter(s => new Date(s.checkintime).toDateString() === today).length,
      checkoutsToday: stays.filter(s => s.checkouttime && new Date(s.checkouttime).toDateString() === today).length,
      revenueToday, revenueThisMonth, revPAR,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no dashboard', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: ROOMS ============
app.get('/api/hotels/:hotelId/rooms', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const rows = await db.q('SELECT * FROM rooms WHERE hotelid = $1', [req.params.hotelId]);
    const rooms = rows.map(r => db.FROM_DB.rooms(r))
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar quartos', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: GUESTS ============
app.post('/api/hotels/:hotelId/guests', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { cpf, name, email, phone } = GuestSchema.parse(req.body);
    const guest = await db.insert('guests', {
      id: randomUUID(), hotelId: req.params.hotelId,
      cpf, name, email: email || null, phone: phone || null,
      totalStays: 0, totalSpent: 0, vipScore: 0,
    });
    const { hotelId: _, ...out } = guest;
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar hóspede', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/guests', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const rows  = await db.q('SELECT * FROM guests WHERE hotelid = $1 ORDER BY name', [req.params.hotelId]);
    res.json(rows.map(r => db.FROM_DB.guests(r)));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar hóspedes', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: STAYS ============
app.post('/api/hotels/:hotelId/stays', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { guestId, roomId, numberOfNights } = StaySchema.parse(req.body);
    const { hotelId } = req.params;
    const room = await db.getById('rooms', roomId);
    if (!room || room.hotelId !== hotelId || room.status !== 'available')
      return res.status(400).json({ error: 'Quarto não disponível', code: 'ROOM_NOT_AVAILABLE' });

    const [stay] = await Promise.all([
      db.insert('stays', {
        id: randomUUID(), hotelId, guestId, roomId,
        numberOfNights, dailyRate: room.dailyRate,
        checkinTime: new Date().toISOString(),
        checkoutTime: null, extras: 0, paymentMethod: null,
      }),
      db.update('rooms', roomId, { status: 'occupied' }),
    ]);
    res.status(201).json(stay);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar hospedagem', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/stays/active/room/:roomId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId, roomId } = req.params;
    const [row] = await db.q(
      'SELECT s.*, g.name AS guestname FROM stays s LEFT JOIN guests g ON g.id = s.guestid WHERE s.hotelid = $1 AND s.roomid = $2 AND s.checkouttime IS NULL LIMIT 1',
      [hotelId, roomId]
    );
    if (!row) return res.status(404).json({ error: 'Hospedagem ativa não encontrada', code: 'NOT_FOUND' });
    const stay = db.FROM_DB.stays(row);
    res.json({ ...stay, guestname: row.guestname });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar hospedagem', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/stays/:stayId/checkout', verifyToken, async (req, res) => {
  try {
    const { stayId } = req.params;
    const { paymentMethod, paymentStatus } = CheckoutBodySchema.parse(req.body);
    const stay = await db.getById('stays', stayId);
    if (!stay) return res.status(404).json({ error: 'Hospedagem não encontrada', code: 'NOT_FOUND' });
    if (stay.hotelId !== req.user.hotelId)
      return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    if (stay.checkoutTime)
      return res.status(409).json({ error: 'Checkout já realizado', code: 'ALREADY_CHECKED_OUT' });

    const now       = new Date().toISOString();
    const total     = (stay.numberOfNights * stay.dailyRate) + (stay.extras || 0);
    const invoiceId = randomUUID();

    // UPDATE atômico — só altera se checkouttime ainda for null. Previne race entre
    // dois checkouts simultâneos no mesmo stay.
    const { data: claimed, error: claimErr } = await db.supabase
      .from('stays')
      .update({ checkouttime: now, paymentmethod: paymentMethod })
      .eq('id', stayId)
      .is('checkouttime', null)
      .select('id');
    if (claimErr) throw claimErr;
    if (!claimed || !claimed.length)
      return res.status(409).json({ error: 'Checkout já realizado', code: 'ALREADY_CHECKED_OUT' });

    await Promise.all([
      db.insert('invoices', {
        id: invoiceId, hotelId: stay.hotelId, stayId,
        total, paymentMethod, status: paymentStatus,
        nfseStatus: FOCUSNFE_TOKEN ? 'processando' : null,
        createdAt: now,
      }),
      db.update('rooms', stay.roomId, { status: 'available' }),
    ]);

    // Dispara emissão NFS-e sem bloquear a resposta
    if (FOCUSNFE_TOKEN) {
      Promise.all([
        db.getById('guests', stay.guestId),
        db.q('SELECT roomnumber FROM rooms WHERE id = $1', [stay.roomId]),
      ]).then(([guest, [room]]) => {
        if (guest && room) emitirNfse(invoiceId, stay, guest, room.roomnumber);
      }).catch(() => {});
    }

    res.json({ success: true, total, invoiceId, nfseEnabled: !!FOCUSNFE_TOKEN });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao fazer checkout', code: 'INTERNAL_ERROR' });
  }
});

// Consulta invoice + status NFS-e (atualiza se ainda processando)
app.get('/api/hotels/:hotelId/invoices/:invoiceId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const invoice = await db.getById('invoices', req.params.invoiceId);
    if (!invoice || invoice.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Invoice não encontrada', code: 'NOT_FOUND' });

    if (invoice.nfseStatus === 'processando' && invoice.nfseId) {
      const data = await consultarNfse(invoice.nfseId);
      if (data && data.status && data.status !== invoice.nfseStatus) {
        const updated = await db.update('invoices', invoice.id, {
          nfseStatus: data.status,
          nfseNumero: data.numero || invoice.nfseNumero,
          nfseUrl:    data.url    || invoice.nfseUrl,
        });
        return res.json(updated);
      }
    }
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar invoice', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: RESERVAS ============

// Disponibilidade de quartos para um período
app.get('/api/hotels/:hotelId/rooms/availability', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { checkin, checkout, exclude } = req.query;
    if (!checkin || !checkout || !isCalendarDate(checkin) || !isCalendarDate(checkout) || checkout <= checkin)
      return res.status(400).json({ error: 'Parâmetros inválidos: checkin e checkout obrigatórios (YYYY-MM-DD) e checkout deve ser após checkin', code: 'INVALID_PARAMS' });
    const rows = await db.q(
      `SELECT r.id, r.roomnumber, r.roomtype, r.capacity, r.dailyrate, r.status,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM reservations res
             WHERE res.roomid = r.id AND res.status = 'confirmed'
             AND res.checkindate < $2::date AND res.checkoutdate > $1::date
             AND ($3 IS NULL OR res.id::text != $3)
           ) OR EXISTS (
             SELECT 1 FROM stays s
             WHERE s.roomid = r.id AND s.checkouttime IS NULL
             AND (s.checkintime::date + s.numberofnights * INTERVAL '1 day')::date > $1::date
           )
         THEN false ELSE true END AS available
       FROM rooms r WHERE r.hotelid = $4 ORDER BY r.roomnumber`,
      [checkin, checkout, exclude || null, hotelId]
    );
    res.json(rows.map(r => ({
      id: r.id, roomNumber: r.roomnumber?.toString(), roomType: r.roomtype,
      capacity: r.capacity, dailyRate: parseFloat(r.dailyrate),
      status: r.status, available: r.available,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao verificar disponibilidade', code: 'INTERNAL_ERROR' });
  }
});

// Listar reservas
app.get('/api/hotels/:hotelId/reservations', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { status, from, to } = req.query;
    let sql = `SELECT r.*, g.name AS guest_name, g.cpf AS guest_cpf,
                 rm.roomnumber, rm.roomtype
               FROM reservations r
               LEFT JOIN guests g  ON g.id  = r.guestid
               LEFT JOIN rooms  rm ON rm.id = r.roomid
               WHERE r.hotelid = $1`;
    const params = [hotelId];
    if (status) { params.push(status); sql += ` AND r.status = $${params.length}`; }
    if (from)   { params.push(from);   sql += ` AND r.checkoutdate >= $${params.length}::date`; }
    if (to)     { params.push(to);     sql += ` AND r.checkindate  <= $${params.length}::date`; }
    sql += ' ORDER BY r.checkindate ASC, r.createdat DESC';
    const rows = await db.q(sql, params);
    res.json(rows.map(r => ({
      ...db.FROM_DB.reservations(r),
      guestName: r.guest_name,
      guestCpf:  r.guest_cpf,
      roomNumber: r.roomnumber?.toString(),
      roomType:   r.roomtype,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar reservas', code: 'INTERNAL_ERROR' });
  }
});

// Criar reserva
app.post('/api/hotels/:hotelId/reservations', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const body = ReservationSchema.parse(req.body);
    const { guestId, roomId, checkinDate, checkoutDate, numberOfGuests, specialRequests } = body;

    const [guest, room] = await Promise.all([db.getById('guests', guestId), db.getById('rooms', roomId)]);
    if (!guest || guest.hotelId !== hotelId) return res.status(404).json({ error: 'Hóspede não encontrado', code: 'NOT_FOUND' });
    if (!room  || room.hotelId  !== hotelId) return res.status(404).json({ error: 'Quarto não encontrado', code: 'NOT_FOUND' });

    const available = await isRoomAvailable(hotelId, roomId, checkinDate, checkoutDate, null);
    if (!available) return res.status(409).json({ error: 'Quarto não disponível para o período solicitado', code: 'ROOM_NOT_AVAILABLE' });

    const numberOfNights = diffDays(checkinDate, checkoutDate);
    const totalValue     = room.dailyRate * numberOfNights;
    const newRes = await db.insert('reservations', {
      id: randomUUID(), hotelId, guestId, roomId,
      checkinDate, checkoutDate, numberOfNights, numberOfGuests,
      dailyRate: room.dailyRate, totalValue,
      specialRequests: specialRequests || null,
      status: 'confirmed', channel: 'direct', source: 'front-desk',
    });
    res.status(201).json(newRes);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos', details: err.errors, code: 'VALIDATION_ERROR' });
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar reserva', code: 'INTERNAL_ERROR' });
  }
});

// Editar reserva
app.put('/api/hotels/:hotelId/reservations/:resId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId, resId } = req.params;
    const reservation = await db.getById('reservations', resId);
    if (!reservation || reservation.hotelId !== hotelId) return res.status(404).json({ error: 'Reserva não encontrada', code: 'NOT_FOUND' });
    if (reservation.status !== 'confirmed') return res.status(409).json({ error: 'Só é possível editar reservas confirmadas', code: 'INVALID_STATUS' });

    const { roomId, checkinDate, checkoutDate, numberOfGuests, specialRequests } = req.body;
    const newRoomId  = roomId      || reservation.roomId;
    const newCheckin = checkinDate || reservation.checkinDate;
    const newCheckout= checkoutDate|| reservation.checkoutDate;
    if (newCheckout <= newCheckin) return res.status(400).json({ error: 'checkoutDate deve ser após checkinDate', code: 'INVALID_DATES' });

    const datesOrRoomChanged = newRoomId !== reservation.roomId || newCheckin !== reservation.checkinDate || newCheckout !== reservation.checkoutDate;
    if (datesOrRoomChanged) {
      const available = await isRoomAvailable(hotelId, newRoomId, newCheckin, newCheckout, resId);
      if (!available) return res.status(409).json({ error: 'Quarto não disponível para o período', code: 'ROOM_NOT_AVAILABLE' });
    }

    const newRoom       = newRoomId !== reservation.roomId ? await db.getById('rooms', newRoomId) : null;
    const dailyRate     = newRoom ? newRoom.dailyRate : reservation.dailyRate;
    const numberOfNights= diffDays(newCheckin, newCheckout);
    const updated = await db.update('reservations', resId, {
      roomId: newRoomId, checkinDate: newCheckin, checkoutDate: newCheckout,
      numberOfNights, numberOfGuests: numberOfGuests ?? reservation.numberOfGuests,
      dailyRate, totalValue: dailyRate * numberOfNights,
      specialRequests: specialRequests !== undefined ? specialRequests : reservation.specialRequests,
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao editar reserva', code: 'INTERNAL_ERROR' });
  }
});

// Cancelar reserva (soft delete)
app.delete('/api/hotels/:hotelId/reservations/:resId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId, resId } = req.params;
    const reservation = await db.getById('reservations', resId);
    if (!reservation || reservation.hotelId !== hotelId) return res.status(404).json({ error: 'Reserva não encontrada', code: 'NOT_FOUND' });
    if (reservation.status === 'checked_in') return res.status(409).json({ error: 'Não é possível cancelar após check-in', code: 'INVALID_STATUS' });
    if (reservation.status === 'cancelled')  return res.status(409).json({ error: 'Reserva já cancelada', code: 'ALREADY_CANCELLED' });
    await db.update('reservations', resId, { status: 'cancelled' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao cancelar reserva', code: 'INTERNAL_ERROR' });
  }
});

// Check-in a partir de reserva
app.post('/api/reservations/:resId/checkin', verifyToken, async (req, res) => {
  try {
    const { resId } = req.params;
    const reservation = await db.getById('reservations', resId);
    if (!reservation) return res.status(404).json({ error: 'Reserva não encontrada', code: 'NOT_FOUND' });
    if (reservation.hotelId !== req.user.hotelId) return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    if (reservation.status !== 'confirmed') return res.status(409).json({ error: 'Reserva não está confirmada', code: 'INVALID_STATUS' });
    const room = await db.getById('rooms', reservation.roomId);
    if (!room || room.status !== 'available') return res.status(409).json({ error: 'Quarto não está disponível', code: 'ROOM_NOT_AVAILABLE' });

    const [stay] = await Promise.all([
      db.insert('stays', {
        id: randomUUID(), hotelId: reservation.hotelId,
        guestId: reservation.guestId, roomId: reservation.roomId,
        numberOfNights: reservation.numberOfNights, dailyRate: reservation.dailyRate,
        checkinTime: new Date().toISOString(), extras: 0,
        reservationId: resId,
      }),
      db.update('rooms', reservation.roomId, { status: 'occupied' }),
      db.update('reservations', resId, { status: 'checked_in' }),
    ]);
    res.status(201).json({ success: true, stayId: stay.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao realizar check-in da reserva', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: GOVERNANÇA — STAFF ============
app.get('/api/hotels/:hotelId/cleaning/staff', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const rows  = await db.q('SELECT * FROM cleaning_staff WHERE hotelid = $1 ORDER BY name', [req.params.hotelId]);
    const staff = rows.map(r => db.FROM_DB.cleaning_staff(r)).map(({ pin, ...s }) => s);
    res.json(staff);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar faxineiras', code: 'INTERNAL_ERROR' });
  }
});

app.post('/api/hotels/:hotelId/cleaning/staff', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { name, pin, phone } = CleaningStaffSchema.parse(req.body);
    const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    const staff   = await db.insert('cleaning_staff', {
      id: randomUUID(), hotelId: req.params.hotelId,
      name, phone: phone || null, pin: pinHash, isActive: true,
    });
    const { pin: _, ...out } = staff;
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar faxineira', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/hotels/:hotelId/cleaning/staff/:staffId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const staff = await db.getById('cleaning_staff', req.params.staffId);
    if (!staff || staff.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Faxineira não encontrada', code: 'NOT_FOUND' });
    const updates = CleaningStaffSchema.partial().parse(req.body);
    if (updates.pin) updates.pin = await bcrypt.hash(updates.pin, BCRYPT_ROUNDS);
    const updated = await db.update('cleaning_staff', req.params.staffId, updates);
    const { pin: _, ...out } = updated;
    res.json(out);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao atualizar faxineira', code: 'INTERNAL_ERROR' });
  }
});

app.delete('/api/hotels/:hotelId/cleaning/staff/:staffId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const staff = await db.getById('cleaning_staff', req.params.staffId);
    if (!staff || staff.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Faxineira não encontrada', code: 'NOT_FOUND' });
    await db.update('cleaning_staff', req.params.staffId, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desativar faxineira', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: GOVERNANÇA — TASKS ============
app.get('/api/hotels/:hotelId/cleaning/tasks', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { status, date, staffId } = req.query;

    let sql    = 'SELECT * FROM cleaning_tasks WHERE hotelid = $1';
    const params = [hotelId];

    if (status)  { sql += ` AND status = $${params.push(status)}`; }
    if (staffId) { sql += ` AND assignedto = $${params.push(staffId)}`; }
    if (date === 'today') { sql += ` AND DATE(createdat) = CURRENT_DATE`; }

    const [taskRows, roomRows, staffRows] = await Promise.all([
      db.q(sql, params),
      db.q('SELECT id, roomnumber FROM rooms WHERE hotelid = $1', [hotelId]),
      db.q('SELECT id, name FROM cleaning_staff WHERE hotelid = $1', [hotelId]),
    ]);

    const roomMap  = Object.fromEntries(roomRows.map(r => [r.id, r.roomnumber?.toString()]));
    const staffMap = Object.fromEntries(staffRows.map(s => [s.id, s.name]));
    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };

    const enriched = taskRows
      .map(r => db.FROM_DB.cleaning_tasks(r))
      .sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9))
      .map(t => ({ ...t, roomNumber: roomMap[t.roomId], staffName: t.assignedTo ? staffMap[t.assignedTo] : null }));

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar tarefas', code: 'INTERNAL_ERROR' });
  }
});

app.post('/api/hotels/:hotelId/cleaning/tasks', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { roomId, assignedTo, priority, estimatedMinutes, notes } = CleaningTaskSchema.parse(req.body);
    const { hotelId } = req.params;

    const room = await db.getById('rooms', roomId);
    if (!room || room.hotelId !== hotelId)
      return res.status(404).json({ error: 'Quarto não encontrado', code: 'NOT_FOUND' });

    if (assignedTo) {
      const staff = await db.getById('cleaning_staff', assignedTo);
      if (!staff || staff.hotelId !== hotelId || !staff.isActive)
        return res.status(400).json({ error: 'Faxineira inativa ou inválida', code: 'INVALID_STAFF' });
    }

    const task = await db.insert('cleaning_tasks', {
      id: randomUUID(), hotelId, roomId, assignedTo: assignedTo || null,
      status: 'pending', priority, estimatedMinutes, actualMinutes: null,
      notes: notes || null, startedAt: null, completedAt: null,
      inspectedAt: null, inspectedBy: null,
    });
    res.status(201).json(task);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar tarefa', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/cleaning/tasks/:taskId/start', verifyToken, async (req, res) => {
  try {
    const task = await db.getById('cleaning_tasks', req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Tarefa não encontrada', code: 'NOT_FOUND' });
    if (task.hotelId !== req.user.hotelId)
      return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    if (task.status !== 'pending')
      return res.status(400).json({ error: 'Tarefa não está pendente', code: 'INVALID_STATUS' });

    const [updated] = await Promise.all([
      db.update('cleaning_tasks', task.id, { status: 'in_progress', startedAt: new Date().toISOString() }),
      db.update('rooms', task.roomId, { status: 'cleaning' }),
    ]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao iniciar tarefa', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/cleaning/tasks/:taskId/complete', verifyToken, async (req, res) => {
  try {
    const task = await db.getById('cleaning_tasks', req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Tarefa não encontrada', code: 'NOT_FOUND' });
    if (task.hotelId !== req.user.hotelId)
      return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    if (task.status !== 'in_progress')
      return res.status(400).json({ error: 'Tarefa não está em andamento', code: 'INVALID_STATUS' });

    const { actualMinutes, notes } = CompleteTaskSchema.parse(req.body);
    const now = new Date();
    const calcMinutes = actualMinutes ?? (task.startedAt
      ? Math.round((now - new Date(task.startedAt)) / 60000) : null);

    const updated = await db.update('cleaning_tasks', task.id, {
      status: 'done', completedAt: now.toISOString(),
      actualMinutes: calcMinutes,
      ...(notes ? { notes } : {}),
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao concluir tarefa', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/cleaning/tasks/:taskId/inspect', verifyToken, async (req, res) => {
  try {
    const task = await db.getById('cleaning_tasks', req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Tarefa não encontrada', code: 'NOT_FOUND' });
    if (task.hotelId !== req.user.hotelId)
      return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    if (task.status !== 'done')
      return res.status(400).json({ error: 'Tarefa ainda não concluída', code: 'INVALID_STATUS' });

    const { score, notes, passed } = InspectTaskSchema.parse(req.body);
    const now = new Date().toISOString();

    await db.insert('cleaning_inspections', {
      id: randomUUID(), taskId: task.id, score, notes: notes || null, passed,
    });

    const updates = { inspectedAt: now, inspectedBy: req.user.id };

    if (passed) {
      updates.status = 'inspected';
      await Promise.all([
        db.update('cleaning_tasks', task.id, updates),
        db.update('rooms', task.roomId, { status: 'available' }),
      ]);
    } else {
      updates.status = 'inspection_failed';
      await Promise.all([
        db.update('cleaning_tasks', task.id, updates),
        db.insert('cleaning_tasks', {
          id: randomUUID(), hotelId: task.hotelId, roomId: task.roomId,
          assignedTo: task.assignedTo, status: 'pending', priority: 'high',
          estimatedMinutes: task.estimatedMinutes, actualMinutes: null,
          notes: `Retrabalho — inspeção reprovada (nota ${score}/5): ${notes || ''}`,
          startedAt: null, completedAt: null, inspectedAt: null, inspectedBy: null,
        }),
      ]);
    }

    const updatedTask = await db.getById('cleaning_tasks', task.id);
    res.json({ task: updatedTask, passed });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao inspecionar tarefa', code: 'INTERNAL_ERROR' });
  }
});

app.post('/api/hotels/:hotelId/cleaning/tasks/generate-daily', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;

    const [checkoutRows, staffRows] = await Promise.all([
      db.q(`SELECT * FROM stays WHERE hotelid = $1 AND checkouttime IS NOT NULL AND DATE(checkouttime) = CURRENT_DATE`, [hotelId]),
      db.q(`SELECT * FROM cleaning_staff WHERE hotelid = $1 AND isactive = true`, [hotelId]),
    ]);

    if (!checkoutRows.length)
      return res.json({ created: 0, message: 'Nenhum checkout hoje' });

    const activeStaff = staffRows.map(r => db.FROM_DB.cleaning_staff(r));
    const created     = [];

    for (let idx = 0; idx < checkoutRows.length; idx++) {
      const stay = db.FROM_DB.stays(checkoutRows[idx]);

      // Evita duplicar tarefas criadas hoje para o mesmo quarto
      const [existing] = await db.q(
        `SELECT id FROM cleaning_tasks WHERE hotelid = $1 AND roomid = $2 AND DATE(createdat) = CURRENT_DATE AND status != 'inspection_failed' LIMIT 1`,
        [hotelId, stay.roomId]
      );
      if (existing) continue;

      const [todayCheckin, tomorrowCheckin] = await Promise.all([
        db.q(`SELECT id FROM stays WHERE hotelid = $1 AND roomid = $2 AND checkouttime IS NULL AND DATE(checkintime) = CURRENT_DATE LIMIT 1`, [hotelId, stay.roomId]),
        db.q(`SELECT id FROM stays WHERE hotelid = $1 AND roomid = $2 AND checkouttime IS NULL AND DATE(checkintime) = CURRENT_DATE + INTERVAL '1 day' LIMIT 1`, [hotelId, stay.roomId]),
      ]);

      const priority   = todayCheckin.length ? 'urgent' : tomorrowCheckin.length ? 'high' : 'normal';
      const assignedTo = activeStaff.length ? activeStaff[idx % activeStaff.length].id : null;

      const task = await db.insert('cleaning_tasks', {
        id: randomUUID(), hotelId, roomId: stay.roomId, assignedTo,
        status: 'pending', priority, estimatedMinutes: 30, actualMinutes: null,
        notes: null, startedAt: null, completedAt: null,
        inspectedAt: null, inspectedBy: null,
      });
      created.push(task);
    }

    res.status(201).json({ created: created.length, tasks: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao gerar tarefas', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: GOVERNANÇA — APP FAXINEIRA ============
app.post('/api/cleaning/auth/login', loginLimiter, async (req, res) => {
  try {
    const { staffId, pin } = StaffLoginSchema.parse(req.body);
    const staff = await db.getById('cleaning_staff', staffId);
    const valid = staff && staff.isActive && await bcrypt.compare(pin, staff.pin);
    if (!valid)
      return res.status(401).json({ error: 'PIN inválido ou conta inativa', code: 'INVALID_CREDENTIALS' });
    const token = jwt.sign(
      { id: staff.id, hotelId: staff.hotelId, name: staff.name, role: 'cleaning_staff' },
      JWT_SECRET, { expiresIn: '12h' }
    );
    const { pin: _, ...safeStaff } = staff;
    res.json({ token, staff: safeStaff });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro no login', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/cleaning/my-tasks', verifyStaffToken, async (req, res) => {
  try {
    const todayPrefix = new Date().toISOString().slice(0, 10);

    const taskRows = await db.q(
      `SELECT * FROM cleaning_tasks WHERE assignedto = $1 AND (
        status IN ('pending','in_progress')
        OR (status IN ('done','inspected') AND DATE(COALESCE(completedat, inspectedat)) = CURRENT_DATE)
      )`,
      [req.staff.id]
    );

    const tasks = taskRows.map(r => db.FROM_DB.cleaning_tasks(r));
    if (!tasks.length) return res.json([]);

    const roomIds = [...new Set(tasks.map(t => t.roomId))];
    // usa supabase-js .in() — exec_sql não suporta arrays como parâmetro
    const { data: roomRows = [] } = await db.supabase
      .from('rooms').select('id, roomnumber, roomtype').in('id', roomIds);
    const roomMap = Object.fromEntries(roomRows.map(r => [r.id, { roomNumber: r.roomnumber?.toString(), roomType: r.roomtype }]));

    const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    const sorted = tasks
      .sort((a, b) => {
        const sw = ({'pending':0,'in_progress':1,'done':2,'inspected':3}[a.status] ?? 9) -
                   ({'pending':0,'in_progress':1,'done':2,'inspected':3}[b.status] ?? 9);
        if (sw !== 0) return sw;
        return (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
      })
      .map(t => ({ ...t, ...roomMap[t.roomId] }));

    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar tarefas', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: TARIFÁRIO DINÂMICO ============
app.get('/api/hotels/:hotelId/seasons', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const rows = await db.q('SELECT * FROM seasons WHERE hotelid = $1 ORDER BY startdate', [req.params.hotelId]);
    res.json(rows.map(r => db.FROM_DB.seasons(r)));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar temporadas', code: 'INTERNAL_ERROR' });
  }
});

app.post('/api/hotels/:hotelId/seasons', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const data      = SeasonSchema.parse(req.body);
    const { hotelId } = req.params;

    const [overlap] = await db.q(
      `SELECT id, name FROM seasons WHERE hotelid = $1 AND type = $2 AND startdate < $3 AND enddate > $4`,
      [hotelId, data.type, data.endDate, data.startDate]
    );
    if (overlap)
      return res.status(409).json({ error: `Sobreposição com temporada "${overlap.name}"`, code: 'DATE_OVERLAP' });

    const season = await db.insert('seasons', { id: randomUUID(), hotelId, ...data });
    res.status(201).json(season);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar temporada', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/hotels/:hotelId/seasons/:seasonId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const season = await db.getById('seasons', req.params.seasonId);
    if (!season || season.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Temporada não encontrada', code: 'NOT_FOUND' });

    const updates = SeasonSchemaBase.partial().parse(req.body);
    const merged  = { ...season, ...updates };

    if (merged.endDate <= merged.startDate)
      return res.status(400).json({ error: 'endDate deve ser após startDate', code: 'VALIDATION_ERROR' });

    const [overlap] = await db.q(
      `SELECT id, name FROM seasons WHERE hotelid = $1 AND type = $2 AND id != $3 AND startdate < $4 AND enddate > $5`,
      [req.params.hotelId, merged.type, season.id, merged.endDate, merged.startDate]
    );
    if (overlap)
      return res.status(409).json({ error: `Sobreposição com temporada "${overlap.name}"`, code: 'DATE_OVERLAP' });

    const updated = await db.update('seasons', season.id, updates);
    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao atualizar temporada', code: 'INTERNAL_ERROR' });
  }
});

app.delete('/api/hotels/:hotelId/seasons/:seasonId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const season = await db.getById('seasons', req.params.seasonId);
    if (!season || season.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Temporada não encontrada', code: 'NOT_FOUND' });
    await db.del('seasons', req.params.seasonId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover temporada', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/weekday-multipliers', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const [row] = await db.q('SELECT weekdaymultipliers FROM hotels WHERE id = $1', [req.params.hotelId]);
    if (!row) return res.status(404).json({ error: 'Hotel não encontrado', code: 'NOT_FOUND' });
    res.json(row.weekdaymultipliers);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar multiplicadores', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/hotels/:hotelId/weekday-multipliers', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const multipliers = WeekdaySchema.parse(req.body);
    // usa supabase-js — objeto JSONB não pode ir via exec_sql params
    await db.supabase.from('hotels').update({ weekdaymultipliers: multipliers }).eq('id', req.params.hotelId);
    res.json(multipliers);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao salvar multiplicadores', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/tariff/calculate', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { roomId, checkin, checkout } = req.query;

    if (!roomId || !checkin || !checkout)
      return res.status(400).json({ error: 'roomId, checkin e checkout são obrigatórios', code: 'MISSING_PARAMS' });

    const checkinDate  = new Date(checkin  + 'T12:00:00');
    const checkoutDate = new Date(checkout + 'T12:00:00');
    if (isNaN(checkinDate) || isNaN(checkoutDate) || checkinDate >= checkoutDate)
      return res.status(400).json({ error: 'Datas inválidas', code: 'INVALID_DATES' });

    const [room, hotelRow, seasonRows] = await Promise.all([
      db.getById('rooms', roomId),
      db.q('SELECT weekdaymultipliers FROM hotels WHERE id = $1', [hotelId]),
      db.q('SELECT * FROM seasons WHERE hotelid = $1', [hotelId]),
    ]);

    if (!room || room.hotelId !== hotelId)
      return res.status(404).json({ error: 'Quarto não encontrado', code: 'NOT_FOUND' });

    const wdMult  = hotelRow[0]?.weekdaymultipliers || {'0':1,'1':1,'2':1,'3':1,'4':1,'5':1,'6':1};
    const seasons = seasonRows.map(r => db.FROM_DB.seasons(r));
    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const basePrice = parseFloat(room.dailyRate);

    const breakdown = [];
    let totalPrice  = 0;
    const current   = new Date(checkinDate);

    while (current < checkoutDate) {
      const dateStr = current.toISOString().split('T')[0];
      const dow     = current.getDay();
      const activeSeason = seasons
        .filter(s => dateStr >= s.startDate && dateStr <= s.endDate)
        .sort((a, b) => b.priceMultiplier - a.priceMultiplier)[0] || null;
      const seasonMultiplier  = activeSeason ? parseFloat(activeSeason.priceMultiplier) : 1.0;
      const weekdayMultiplier = parseFloat(wdMult[String(dow)] ?? 1.0);
      const finalPrice        = parseFloat((basePrice * seasonMultiplier * weekdayMultiplier).toFixed(2));
      breakdown.push({ date: dateStr, dayOfWeek: DAY_NAMES[dow], season: activeSeason?.name || null, seasonType: activeSeason?.type || null, seasonMultiplier, weekdayMultiplier, finalPrice });
      totalPrice += finalPrice;
      current.setDate(current.getDate() + 1);
    }

    const totalNights = breakdown.length;
    res.json({
      roomNumber: room.roomNumber, roomType: room.roomType, basePrice, totalNights, breakdown,
      totalPrice: parseFloat(totalPrice.toFixed(2)),
      averageDailyRate: parseFloat((totalPrice / totalNights).toFixed(2)),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao calcular tarifa', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: RELATÓRIOS ============
function dateRange(from, to) {
  const dates = [], cur = new Date(from + 'T12:00:00'), end = new Date(to + 'T12:00:00');
  while (cur <= end) { dates.push(cur.toISOString().split('T')[0]); cur.setDate(cur.getDate() + 1); }
  return dates;
}
function prevPeriod(from, to) {
  const f = new Date(from + 'T12:00:00'), t = new Date(to + 'T12:00:00');
  const days  = Math.round((t - f) / 86400000);
  const pTo   = new Date(f - 86400000), pFrom = new Date(pTo - days * 86400000);
  return { from: pFrom.toISOString().split('T')[0], to: pTo.toISOString().split('T')[0] };
}
function parseReportParams(req, res) {
  const toDefault   = new Date().toISOString().split('T')[0];
  const fromDefault = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const from = req.query.from || fromDefault;
  const to   = req.query.to   || toDefault;
  if (from > to) { res.status(400).json({ error: 'from deve ser anterior a to', code: 'INVALID_RANGE' }); return null; }
  return { from, to };
}

async function occupiedRoomNightsInPeriod(hotelId, from, to) {
  // Stay sobrepõe [from, to] se checkin <= to E (checkout > from OU checkout NULL)
  const stays = await db.q(
    `SELECT checkintime, checkouttime FROM stays
     WHERE hotelid = $1
       AND DATE(checkintime) <= $3::date
       AND (checkouttime IS NULL OR DATE(checkouttime) > $2::date)`,
    [hotelId, from, to]
  );
  const dates = dateRange(from, to);
  let total = 0;
  const byDay = dates.map(date => {
    const occ = stays.filter(s => {
      const cin  = new Date(s.checkintime).toISOString().split('T')[0];
      const cout = s.checkouttime ? new Date(s.checkouttime).toISOString().split('T')[0] : '9999-12-31';
      return cin <= date && cout > date;
    }).length;
    total += occ;
    return { date, occupiedRooms: occ };
  });
  return { total, byDay };
}

app.get('/api/hotels/:hotelId/reports/occupancy', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const p = parseReportParams(req, res); if (!p) return;
    const { hotelId } = req.params;

    const [[{ cnt: totalRooms }], { total: occupiedRoomNights, byDay }] = await Promise.all([
      db.q('SELECT COUNT(*)::int AS cnt FROM rooms WHERE hotelid = $1', [hotelId]),
      occupiedRoomNightsInPeriod(hotelId, p.from, p.to),
    ]);

    const dates           = dateRange(p.from, p.to);
    const totalDays       = dates.length;
    const availNights     = totalRooms * totalDays;
    const occupancyRate   = availNights > 0 ? parseFloat((occupiedRoomNights / availNights * 100).toFixed(2)) : 0;

    const prev = prevPeriod(p.from, p.to);
    const { total: prevOcc } = await occupiedRoomNightsInPeriod(hotelId, prev.from, prev.to);
    const prevRate = availNights > 0 ? parseFloat((prevOcc / availNights * 100).toFixed(2)) : 0;

    res.json({
      period: p, totalRooms, totalDaysInPeriod: totalDays,
      occupiedRoomNights, availableRoomNights: availNights,
      occupancyRate, averageOccupancy: occupancyRate,
      byDay: byDay.map(d => ({ ...d, availableRooms: totalRooms, rate: totalRooms > 0 ? parseFloat((d.occupiedRooms / totalRooms * 100).toFixed(1)) : 0 })),
      comparison: { previousPeriodRate: prevRate, change: parseFloat((occupancyRate - prevRate).toFixed(2)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no relatório de ocupação', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/reports/revenue', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const p = parseReportParams(req, res); if (!p) return;
    const { hotelId } = req.params;

    const [invoiceRows, [{ cnt: roomCount }], stayRows] = await Promise.all([
      db.q(`SELECT i.*, s.roomid FROM invoices i LEFT JOIN stays s ON s.id = i.stayid WHERE i.hotelid = $1 AND i.status = 'paid' AND DATE(i.createdat) BETWEEN $2 AND $3`, [hotelId, p.from, p.to]),
      db.q('SELECT COUNT(*)::int AS cnt FROM rooms WHERE hotelid = $1', [hotelId]),
      db.q('SELECT id, roomid FROM stays WHERE hotelid = $1', [hotelId]),
    ]);
    const roomRows = await db.q('SELECT id, roomtype FROM rooms WHERE hotelid = $1', [hotelId]);
    const roomTypeMap = Object.fromEntries(roomRows.map(r => [r.id, r.roomtype]));

    const invoices     = invoiceRows.map(r => ({ ...db.FROM_DB.invoices(r), roomId: r.roomid }));
    const totalRevenue = invoices.reduce((s, i) => s + (i.total || 0), 0);

    const byPaymentMethod = {}, byRoomType = {}, byDayMap = {};
    for (const inv of invoices) {
      byPaymentMethod[inv.paymentMethod] = (byPaymentMethod[inv.paymentMethod] || 0) + inv.total;
      const type = roomTypeMap[inv.roomId] || 'outros';
      byRoomType[type] = (byRoomType[type] || 0) + inv.total;
      const day = inv.createdAt.split('T')[0];
      byDayMap[day] = (byDayMap[day] || 0) + inv.total;
    }
    const byDay = Object.entries(byDayMap).sort().map(([date, revenue]) => ({ date, revenue: parseFloat(revenue.toFixed(2)) }));
    const { total: occNights } = await occupiedRoomNightsInPeriod(hotelId, p.from, p.to);
    const dates  = dateRange(p.from, p.to);
    const ADR    = occNights > 0   ? parseFloat((totalRevenue / occNights).toFixed(2)) : 0;
    const revPAR = roomCount > 0   ? parseFloat((totalRevenue / (roomCount * dates.length)).toFixed(2)) : 0;

    res.json({
      period: p, totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      byPaymentMethod: Object.fromEntries(Object.entries(byPaymentMethod).map(([k,v]) => [k, parseFloat(v.toFixed(2))])),
      byRoomType: Object.fromEntries(Object.entries(byRoomType).map(([k,v]) => [k, parseFloat(v.toFixed(2))])),
      byDay, averageDailyRate: ADR, revPAR,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no relatório de receita', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/reports/guests', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const p = parseReportParams(req, res); if (!p) return;
    const { hotelId } = req.params;

    const [stayRows, fnrhRows, vipRows] = await Promise.all([
      db.q(`SELECT guestid FROM stays WHERE hotelid = $1 AND DATE(checkintime) BETWEEN $2 AND $3`, [hotelId, p.from, p.to]),
      db.q(`SELECT * FROM fnrh_records WHERE hotelid = $1 AND arrivaldate BETWEEN $2 AND $3`, [hotelId, p.from, p.to]),
      db.q(`SELECT COUNT(*)::int AS cnt FROM guests WHERE hotelid = $1 AND vipscore > 50`, [hotelId]),
    ]);

    const guestIdSet   = new Set(stayRows.map(s => s.guestid));
    const totalGuests  = guestIdSet.size;
    const fnrhs        = fnrhRows.map(r => db.FROM_DB.fnrh_records(r));

    const byNationality = {}, byOriginState = {}, byPurpose = {};
    const ageRanges = {'<18':0,'18-25':0,'26-35':0,'36-45':0,'46-55':0,'56-65':0,'>65':0};

    for (const f of fnrhs) {
      const nat = f.nationality || 'Não informado';
      byNationality[nat] = (byNationality[nat] || 0) + 1;
      if (f.addressState) byOriginState[f.addressState] = (byOriginState[f.addressState] || 0) + 1;
      if (f.purpose)      byPurpose[f.purpose]          = (byPurpose[f.purpose]          || 0) + 1;
      if (f.birthDate) {
        const age = Math.floor((Date.now() - new Date(f.birthDate)) / (365.25 * 86400000));
        if      (age < 18)  ageRanges['<18']++;
        else if (age <= 25) ageRanges['18-25']++;
        else if (age <= 35) ageRanges['26-35']++;
        else if (age <= 45) ageRanges['36-45']++;
        else if (age <= 55) ageRanges['46-55']++;
        else if (age <= 65) ageRanges['56-65']++;
        else                ageRanges['>65']++;
      }
    }

    const staysFull = await db.q(`SELECT numberofnights FROM stays WHERE hotelid = $1 AND DATE(checkintime) BETWEEN $2 AND $3`, [hotelId, p.from, p.to]);
    const avgDuration = staysFull.length > 0
      ? parseFloat((staysFull.reduce((s, st) => s + (st.numberofnights || 0), 0) / staysFull.length).toFixed(1)) : 0;

    res.json({ period: p, totalGuests, byNationality, byOriginState, byAgeRange: ageRanges, byPurpose, averageStayDuration: avgDuration, vipGuests: vipRows[0]?.cnt || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no relatório de hóspedes', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/reports/staff-performance', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const p = parseReportParams(req, res); if (!p) return;
    const { hotelId } = req.params;

    const [staffRows, taskRows, inspectionRows] = await Promise.all([
      db.q('SELECT * FROM cleaning_staff WHERE hotelid = $1', [hotelId]),
      db.q(`SELECT * FROM cleaning_tasks WHERE hotelid = $1 AND status IN ('done','inspected','inspection_failed') AND completedat IS NOT NULL AND DATE(completedat) BETWEEN $2 AND $3`, [hotelId, p.from, p.to]),
      db.q(`SELECT ci.* FROM cleaning_inspections ci JOIN cleaning_tasks ct ON ct.id = ci.taskid WHERE ct.hotelid = $1`, [hotelId]),
    ]);

    const tasksByStaff   = {};
    for (const t of taskRows) {
      if (!tasksByStaff[t.assignedto]) tasksByStaff[t.assignedto] = [];
      tasksByStaff[t.assignedto].push(t);
    }
    const inspByTask = {};
    for (const i of inspectionRows) {
      if (!inspByTask[i.taskid]) inspByTask[i.taskid] = [];
      inspByTask[i.taskid].push(i);
    }

    const result = staffRows.map(s => {
      const tasks         = tasksByStaff[s.id] || [];
      const tasksCompleted = tasks.length;
      const avgMin        = tasksCompleted > 0 ? parseFloat((tasks.filter(t => t.actualminutes).reduce((sum, t) => sum + t.actualminutes, 0) / tasksCompleted).toFixed(1)) : 0;
      const inspections   = tasks.flatMap(t => inspByTask[t.id] || []);
      const totalInsp     = inspections.length;
      const avgScore      = totalInsp > 0 ? parseFloat((inspections.reduce((sum, i) => sum + (i.score || 0), 0) / totalInsp).toFixed(1)) : null;
      const passRate      = totalInsp > 0 ? parseFloat((inspections.filter(i => i.passed).length / totalInsp * 100).toFixed(1)) : null;
      return { id: s.id, name: s.name, tasksCompleted, averageMinutes: avgMin, inspectionScore: avgScore, passRate };
    });

    res.json({ period: p, staff: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no relatório de performance', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/reports/financial', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const p = parseReportParams(req, res); if (!p) return;
    const { hotelId } = req.params;

    const [invoiceRows, [{ cnt: roomCount }]] = await Promise.all([
      db.q(`SELECT totalvalue, createdat FROM invoices WHERE hotelid = $1 AND status = 'paid' AND DATE(createdat) BETWEEN $2 AND $3`, [hotelId, p.from, p.to]),
      db.q('SELECT COUNT(*)::int AS cnt FROM rooms WHERE hotelid = $1', [hotelId]),
    ]);

    const revenue   = parseFloat(invoiceRows.reduce((s, i) => s + parseFloat(i.totalvalue || 0), 0).toFixed(2));
    const avgTicket = invoiceRows.length > 0 ? parseFloat((revenue / invoiceRows.length).toFixed(2)) : 0;

    const dates     = dateRange(p.from, p.to);
    const { total: occNights } = await occupiedRoomNightsInPeriod(hotelId, p.from, p.to);
    const availNights = roomCount * dates.length;
    const occRate     = availNights > 0 ? parseFloat((occNights / availNights * 100).toFixed(2)) : 0;
    const ADR         = occNights > 0   ? parseFloat((revenue / occNights).toFixed(2)) : 0;
    const revPAR      = availNights > 0 ? parseFloat((revenue / availNights).toFixed(2)) : 0;

    const prev = prevPeriod(p.from, p.to);
    const [prevInvRows] = await Promise.all([
      db.q(`SELECT totalvalue FROM invoices WHERE hotelid = $1 AND status = 'paid' AND DATE(createdat) BETWEEN $2 AND $3`, [hotelId, prev.from, prev.to]),
    ]);
    const prevRevenue = parseFloat(prevInvRows.reduce((s, i) => s + parseFloat(i.totalvalue || 0), 0).toFixed(2));
    const { total: prevOcc } = await occupiedRoomNightsInPeriod(hotelId, prev.from, prev.to);
    const prevOccRate = availNights > 0 ? parseFloat((prevOcc / availNights * 100).toFixed(2)) : 0;

    res.json({
      period: p, revenue, expenses: 0, profit: revenue,
      averageTicket: avgTicket, occupancyRate: occRate, ADR, revPAR,
      comparison: {
        previousPeriod: prev, previousRevenue: prevRevenue,
        revenueChange:  parseFloat((revenue - prevRevenue).toFixed(2)),
        previousOccRate: prevOccRate,
        occupancyChange: parseFloat((occRate - prevOccRate).toFixed(2)),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no relatório financeiro', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: FNRH ============
app.post('/api/hotels/:hotelId/fnrh', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const data      = FNRHSchema.parse(req.body);
    const { hotelId } = req.params;

    const stay = await db.getById('stays', data.stayId);
    if (!stay || stay.hotelId !== hotelId)
      return res.status(404).json({ error: 'Hospedagem não encontrada', code: 'NOT_FOUND' });
    if (stay.guestId !== data.guestId)
      return res.status(422).json({ error: 'Hóspede não corresponde à hospedagem', code: 'GUEST_STAY_MISMATCH' });

    const [existing] = await db.q('SELECT id FROM fnrh_records WHERE stayid = $1 LIMIT 1', [data.stayId]);
    if (existing)
      return res.status(409).json({ error: 'FNRH já registrado para esta hospedagem', code: 'DUPLICATE', id: existing.id });

    const record = await db.insert('fnrh_records', {
      id: randomUUID(), hotelId, ...data,
      exportedToSismatur: false, exportedAt: null,
    });
    res.status(201).json(record);
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR', details: err.errors });
    res.status(500).json({ error: 'Erro ao criar FNRH', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/fnrh', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { month, exported, page = '1', limit = '20' } = req.query;

    const params = [hotelId];
    let where    = 'WHERE hotelid = $1';
    if (month)                   { where += ` AND TO_CHAR(arrivaldate,'YYYY-MM') = $${params.push(month)}`; }
    if (exported !== undefined)  { where += ` AND exportedtosismatur = $${params.push(exported === 'true')}`; }

    const pageNum = Math.max(1, parseInt(page));
    const lim     = Math.min(100, Math.max(1, parseInt(limit)));
    const offset  = (pageNum - 1) * lim;

    const [{ cnt: total }] = await db.q(`SELECT COUNT(*)::int AS cnt FROM fnrh_records ${where}`, params);
    const dataParams = [...params, lim, offset];
    const rows = await db.q(
      `SELECT * FROM fnrh_records ${where} ORDER BY arrivaldate DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      dataParams
    );
    const data = rows.map(r => db.FROM_DB.fnrh_records(r));
    res.json({ total, page: pageNum, limit: lim, pages: Math.ceil(total / lim), data });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar FNRHs', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/hotels/:hotelId/fnrh/:recordId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const record = await db.getById('fnrh_records', req.params.recordId);
    if (!record || record.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Registro não encontrado', code: 'NOT_FOUND' });
    if (record.exportedToSismatur)
      return res.status(400).json({ error: 'Registro já exportado não pode ser editado', code: 'ALREADY_EXPORTED' });

    const updates    = FNRHPartialSchema.parse(req.body);
    const newStayId  = updates.stayId  || record.stayId;
    const newGuestId = updates.guestId || record.guestId;

    if (updates.stayId || updates.guestId) {
      const stay = await db.getById('stays', newStayId);
      if (!stay || stay.hotelId !== req.params.hotelId)
        return res.status(404).json({ error: 'Hospedagem não encontrada', code: 'NOT_FOUND' });
      if (stay.guestId !== newGuestId)
        return res.status(422).json({ error: 'Hóspede não corresponde à hospedagem', code: 'GUEST_STAY_MISMATCH' });
    }

    const updated = await db.update('fnrh_records', req.params.recordId, { ...updates, updatedAt: new Date().toISOString() });
    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR', details: err.errors });
    res.status(500).json({ error: 'Erro ao editar FNRH', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/fnrh/export', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { month }   = req.query;

    let sql    = `SELECT * FROM fnrh_records WHERE hotelid = $1 AND exportedtosismatur = false`;
    const params = [hotelId];
    if (month) { sql += ` AND TO_CHAR(arrivaldate,'YYYY-MM') = $${params.push(month)}`; }

    const rows    = await db.q(sql, params);
    const records = rows.map(r => db.FROM_DB.fnrh_records(r));

    if (!records.length)
      return res.status(404).json({ error: 'Nenhum registro pendente de exportação', code: 'NOT_FOUND' });

    const lines = records.map(r => [
      removeAccents(r.fullName),
      r.documentNumber.replace(/\D/g, ''),
      fmtDate(r.birthDate),
      removeAccents(r.nationality || 'BRASILEIRO'),
      removeAccents(r.profession || ''),
      removeAccents(`${r.addressStreet || ''} ${r.addressNumber || ''}`.trim()),
      removeAccents(r.addressCity || ''),
      (r.addressState || '').toUpperCase(),
      (r.addressZipcode || '').replace(/\D/g, ''),
      fmtDate(r.arrivalDate),
      fmtDate(r.departureDate),
      removeAccents(r.purpose || ''),
      removeAccents(r.originCity || ''),
      removeAccents(r.destinationCity || ''),
      removeAccents(r.transportMethod || ''),
    ].join('|'));

    // Marca como exportados em batch (usa supabase-js .in() — exec_sql não suporta uuid[])
    const now = new Date().toISOString();
    const ids = records.map(r => r.id);
    await db.supabase.from('fnrh_records')
      .update({ exportedtosismatur: true, exportedat: now }).in('id', ids);

    const safeMonth = month ? month.replace(/[^0-9-]/g, '').replace('-', '') : null;
    const filename  = safeMonth ? `fnrh_${safeMonth}.txt` : `fnrh_${new Date().toISOString().slice(0,7).replace('-','')}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao exportar FNRH', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: CHANNEL MANAGER ============

const IntegrationSchema = z.object({
  type:   z.enum(['booking.com', 'decolar']),
  apiKey: z.string().min(16).max(128),
  status: z.enum(['active', 'inactive']).default('active'),
});

// Listar canais configurados
app.get('/api/hotels/:hotelId/channels', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const rows = await db.q(
      `SELECT * FROM integrations WHERE hotelid = $1 AND type IN ('booking.com', 'decolar') ORDER BY createdat`,
      [hotelId]
    );
    res.json(rows.map(db.FROM_DB.integrations));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar canais', code: 'INTERNAL_ERROR' });
  }
});

// Configurar canal (upsert)
app.post('/api/hotels/:hotelId/channels', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const body = IntegrationSchema.parse(req.body);
    const [existing] = await db.q(
      `SELECT id FROM integrations WHERE hotelid = $1 AND type = $2 LIMIT 1`,
      [hotelId, body.type]
    );
    let channel;
    if (existing) {
      channel = await db.update('integrations', existing.id, { apiKey: body.apiKey, status: body.status });
    } else {
      channel = await db.insert('integrations', {
        id: randomUUID(), hotelId, type: body.type, apiKey: body.apiKey, status: body.status,
      });
    }
    res.status(201).json(channel);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(422).json({ error: 'Dados inválidos', details: err.errors });
    console.error(err);
    res.status(500).json({ error: 'Erro ao configurar canal', code: 'INTERNAL_ERROR' });
  }
});

// Atualizar canal
app.put('/api/hotels/:hotelId/channels/:channelId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId, channelId } = req.params;
    const integration = await db.getById('integrations', channelId);
    if (!integration || integration.hotelId !== hotelId)
      return res.status(404).json({ error: 'Canal não encontrado', code: 'NOT_FOUND' });
    const body = IntegrationSchema.partial().parse(req.body);
    const updated = await db.update('integrations', channelId, body);
    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(422).json({ error: 'Dados inválidos', details: err.errors });
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar canal', code: 'INTERNAL_ERROR' });
  }
});

// Remover canal
app.delete('/api/hotels/:hotelId/channels/:channelId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId, channelId } = req.params;
    const integration = await db.getById('integrations', channelId);
    if (!integration || integration.hotelId !== hotelId)
      return res.status(404).json({ error: 'Canal não encontrado', code: 'NOT_FOUND' });
    await db.del('integrations', channelId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao remover canal', code: 'INTERNAL_ERROR' });
  }
});

// Stats por canal
app.get('/api/hotels/:hotelId/channels/stats', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { hotelId } = req.params;
    const rows = await db.q(
      `SELECT channel, COUNT(*)::int AS reservations,
              COALESCE(SUM(totalvalue), 0)::float AS revenue
       FROM reservations WHERE hotelid = $1 AND status != 'cancelled'
       GROUP BY channel ORDER BY revenue DESC`,
      [hotelId]
    );
    res.json(rows.map(r => ({
      channel: r.channel,
      reservations: r.reservations,
      revenue: parseFloat(r.revenue),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas de canais', code: 'INTERNAL_ERROR' });
  }
});

// ── helpers internos ──────────────────────────────────────────────────────────

async function authenticateWebhook(hotelSlug, channelType, apiKey) {
  const [hotel] = await db.q(`SELECT id FROM hotels WHERE slug = $1 LIMIT 1`, [hotelSlug]);
  if (!hotel) return null;
  const [integration] = await db.q(
    `SELECT id FROM integrations WHERE hotelid = $1 AND type = $2 AND status = 'active' AND apikey = $3 LIMIT 1`,
    [hotel.id, channelType, apiKey]
  );
  if (!integration) return null;
  return { hotelId: hotel.id };
}

async function findOrCreateGuest(hotelId, { name, email, phone, document }) {
  if (email) {
    const [existing] = await db.q(
      `SELECT id FROM guests WHERE hotelid = $1 AND email = $2 LIMIT 1`, [hotelId, email]
    );
    if (existing) return existing.id;
  }
  const guest = await db.insert('guests', {
    id: randomUUID(), hotelId, name, email: email || null, phone: phone || null,
    cpf: document || null, totalStays: 0, totalSpent: 0, vipScore: 0,
  });
  return guest.id;
}

async function findAvailableRoom(hotelId, roomType, checkinDate, checkoutDate) {
  const [room] = await db.q(
    `SELECT r.id FROM rooms r
     WHERE r.hotelid = $1 AND LOWER(r.roomtype) = LOWER($2)
       AND r.status != 'maintenance'
       AND NOT EXISTS (
         SELECT 1 FROM reservations res
         WHERE res.roomid = r.id AND res.status = 'confirmed'
           AND res.checkindate < $4::date AND res.checkoutdate > $3::date
       )
       AND NOT EXISTS (
         SELECT 1 FROM stays s
         WHERE s.roomid = r.id AND s.checkouttime IS NULL
           AND (s.checkintime::date + s.numberofnights * INTERVAL '1 day')::date > $3::date
       )
     LIMIT 1`,
    [hotelId, roomType, checkinDate, checkoutDate]
  );
  return room || null;
}

// ── Webhook Booking.com ───────────────────────────────────────────────────────
// Header: X-Booking-Api-Key
// Body: { reservation_id, room_type, check_in, check_out, guests_count, total_price,
//         guest: { first_name, last_name, email, phone, document }, special_requests }
app.post('/api/webhook/booking/:hotelSlug', async (req, res) => {
  try {
    const apiKey = req.headers['x-booking-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'X-Booking-Api-Key obrigatório', code: 'UNAUTHORIZED' });

    const auth = await authenticateWebhook(req.params.hotelSlug, 'booking.com', apiKey);
    if (!auth) return res.status(401).json({ error: 'Credenciais inválidas', code: 'UNAUTHORIZED' });

    const { hotelId } = auth;
    const b = req.body;

    if (!b.reservation_id || !b.room_type || !b.check_in || !b.check_out || !b.guest)
      return res.status(400).json({ error: 'Payload inválido', code: 'INVALID_PAYLOAD' });
    if (!isCalendarDate(b.check_in) || !isCalendarDate(b.check_out) || b.check_out <= b.check_in)
      return res.status(400).json({ error: 'Datas inválidas', code: 'INVALID_DATES' });

    // Idempotência — evita duplicata
    const [dup] = await db.q(
      `SELECT id FROM reservations WHERE hotelid = $1 AND source = $2 LIMIT 1`,
      [hotelId, `booking:${b.reservation_id}`]
    );
    if (dup) return res.json({ message: 'Reserva já processada', reservationId: dup.id });

    const room = await findAvailableRoom(hotelId, b.room_type, b.check_in, b.check_out);
    if (!room) return res.status(409).json({ error: 'Nenhum quarto disponível para esse tipo e período', code: 'NO_ROOM_AVAILABLE' });

    const guestId = await findOrCreateGuest(hotelId, {
      name:     `${b.guest.first_name} ${b.guest.last_name}`.trim(),
      email:    b.guest.email,
      phone:    b.guest.phone,
      document: b.guest.document,
    });

    const nights   = diffDays(b.check_in, b.check_out);
    const roomData = await db.getById('rooms', room.id);
    const totalValue = b.total_price ?? (roomData.dailyRate * nights);

    const reservation = await db.insert('reservations', {
      id: randomUUID(), hotelId, guestId, roomId: room.id,
      checkinDate: b.check_in, checkoutDate: b.check_out,
      numberOfNights: nights, numberOfGuests: b.guests_count ?? 1,
      channel: 'booking.com', source: `booking:${b.reservation_id}`,
      status: 'confirmed', dailyRate: roomData.dailyRate, totalValue,
      depositPaid: 0, specialRequests: b.special_requests || null,
    });

    await db.supabase.from('integrations')
      .update({ lastsyncdate: new Date().toISOString() })
      .eq('hotelid', hotelId).eq('type', 'booking.com');

    res.status(201).json({ success: true, reservationId: reservation.id });
  } catch (err) {
    console.error('[webhook/booking]', err);
    res.status(500).json({ error: 'Erro interno ao processar reserva', code: 'INTERNAL_ERROR' });
  }
});

// ── Webhook Decolar ───────────────────────────────────────────────────────────
// Header: X-Decolar-Api-Key
// Body: { bookingId, roomTypeId, arrivalDate, departureDate, adultsCount, bookingAmount,
//         traveler: { firstName, lastName, emailAddress, phoneNumber, documentNumber }, specialRequest }
app.post('/api/webhook/decolar/:hotelSlug', async (req, res) => {
  try {
    const apiKey = req.headers['x-decolar-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'X-Decolar-Api-Key obrigatório', code: 'UNAUTHORIZED' });

    const auth = await authenticateWebhook(req.params.hotelSlug, 'decolar', apiKey);
    if (!auth) return res.status(401).json({ error: 'Credenciais inválidas', code: 'UNAUTHORIZED' });

    const { hotelId } = auth;
    const b = req.body;

    if (!b.bookingId || !b.roomTypeId || !b.arrivalDate || !b.departureDate || !b.traveler)
      return res.status(400).json({ error: 'Payload inválido', code: 'INVALID_PAYLOAD' });
    if (!isCalendarDate(b.arrivalDate) || !isCalendarDate(b.departureDate) || b.departureDate <= b.arrivalDate)
      return res.status(400).json({ error: 'Datas inválidas', code: 'INVALID_DATES' });

    const [dup] = await db.q(
      `SELECT id FROM reservations WHERE hotelid = $1 AND source = $2 LIMIT 1`,
      [hotelId, `decolar:${b.bookingId}`]
    );
    if (dup) return res.json({ message: 'Reserva já processada', reservationId: dup.id });

    const room = await findAvailableRoom(hotelId, b.roomTypeId, b.arrivalDate, b.departureDate);
    if (!room) return res.status(409).json({ error: 'Nenhum quarto disponível para esse tipo e período', code: 'NO_ROOM_AVAILABLE' });

    const guestId = await findOrCreateGuest(hotelId, {
      name:     `${b.traveler.firstName} ${b.traveler.lastName}`.trim(),
      email:    b.traveler.emailAddress,
      phone:    b.traveler.phoneNumber,
      document: b.traveler.documentNumber,
    });

    const nights   = diffDays(b.arrivalDate, b.departureDate);
    const roomData = await db.getById('rooms', room.id);
    const totalValue = b.bookingAmount ?? (roomData.dailyRate * nights);

    const reservation = await db.insert('reservations', {
      id: randomUUID(), hotelId, guestId, roomId: room.id,
      checkinDate: b.arrivalDate, checkoutDate: b.departureDate,
      numberOfNights: nights, numberOfGuests: b.adultsCount ?? 1,
      channel: 'decolar', source: `decolar:${b.bookingId}`,
      status: 'confirmed', dailyRate: roomData.dailyRate, totalValue,
      depositPaid: 0, specialRequests: b.specialRequest || null,
    });

    await db.supabase.from('integrations')
      .update({ lastsyncdate: new Date().toISOString() })
      .eq('hotelid', hotelId).eq('type', 'decolar');

    res.status(201).json({ success: true, reservationId: reservation.id });
  } catch (err) {
    console.error('[webhook/decolar]', err);
    res.status(500).json({ error: 'Erro interno ao processar reserva', code: 'INTERNAL_ERROR' });
  }
});

// ── Disponibilidade para OTAs ────────────────────────────────────────────────
// Header: X-Api-Key  |  Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/channels/:hotelSlug/availability', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'X-Api-Key obrigatório', code: 'UNAUTHORIZED' });

    const [hotel] = await db.q(`SELECT id FROM hotels WHERE slug = $1 LIMIT 1`, [req.params.hotelSlug]);
    if (!hotel) return res.status(404).json({ error: 'Hotel não encontrado', code: 'NOT_FOUND' });

    const [integration] = await db.q(
      `SELECT id FROM integrations WHERE hotelid = $1 AND apikey = $2 AND status = 'active' LIMIT 1`,
      [hotel.id, apiKey]
    );
    if (!integration) return res.status(401).json({ error: 'Credenciais inválidas', code: 'UNAUTHORIZED' });

    const { from, to } = req.query;
    if (!from || !to || !isCalendarDate(from) || !isCalendarDate(to) || to <= from)
      return res.status(400).json({ error: 'Parâmetros from e to são obrigatórios (YYYY-MM-DD)', code: 'INVALID_PARAMS' });

    const rooms = await db.q(
      `SELECT r.id, r.roomnumber, r.roomtype, r.capacity, r.dailyrate,
              (r.status != 'maintenance'
               AND NOT EXISTS (
                 SELECT 1 FROM reservations res
                 WHERE res.roomid = r.id AND res.status = 'confirmed'
                   AND res.checkindate < $3::date AND res.checkoutdate > $2::date
               )
               AND NOT EXISTS (
                 SELECT 1 FROM stays s
                 WHERE s.roomid = r.id AND s.checkouttime IS NULL
                   AND (s.checkintime::date + s.numberofnights * INTERVAL '1 day')::date > $2::date
               )
              ) AS available
       FROM rooms r WHERE r.hotelid = $1 ORDER BY r.roomnumber`,
      [hotel.id, from, to]
    );

    res.json({
      hotelSlug: req.params.hotelSlug,
      from, to,
      rooms: rooms.map(r => ({
        id: r.id,
        roomNumber: r.roomnumber,
        roomType: r.roomtype,
        capacity: r.capacity,
        dailyRate: parseFloat(r.dailyrate),
        available: r.available,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao consultar disponibilidade', code: 'INTERNAL_ERROR' });
  }
});

// ── Tarifas para OTAs ────────────────────────────────────────────────────────
// Header: X-Api-Key  |  Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/channels/:hotelSlug/rates', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'X-Api-Key obrigatório', code: 'UNAUTHORIZED' });

    const [hotel] = await db.q(
      `SELECT id, weekdaymultipliers FROM hotels WHERE slug = $1 LIMIT 1`, [req.params.hotelSlug]
    );
    if (!hotel) return res.status(404).json({ error: 'Hotel não encontrado', code: 'NOT_FOUND' });

    const [integration] = await db.q(
      `SELECT id FROM integrations WHERE hotelid = $1 AND apikey = $2 AND status = 'active' LIMIT 1`,
      [hotel.id, apiKey]
    );
    if (!integration) return res.status(401).json({ error: 'Credenciais inválidas', code: 'UNAUTHORIZED' });

    const { from, to } = req.query;
    if (!from || !to || !isCalendarDate(from) || !isCalendarDate(to) || to <= from)
      return res.status(400).json({ error: 'Parâmetros from e to são obrigatórios', code: 'INVALID_PARAMS' });

    const [roomTypes, seasons] = await Promise.all([
      db.q(
        `SELECT DISTINCT ON (roomtype) roomtype, dailyrate FROM rooms WHERE hotelid = $1 ORDER BY roomtype, dailyrate`,
        [hotel.id]
      ),
      db.q(
        `SELECT type, pricemultiplier, startdate::text, enddate::text FROM seasons
         WHERE hotelid = $1 AND startdate <= $3::date AND enddate >= $2::date`,
        [hotel.id, from, to]
      ),
    ]);

    res.json({
      hotelSlug: req.params.hotelSlug,
      from, to,
      roomTypes: roomTypes.map(r => ({ roomType: r.roomtype, baseRate: parseFloat(r.dailyrate) })),
      seasons: seasons.map(s => ({
        type: s.type, multiplier: parseFloat(s.pricemultiplier), from: s.startdate, to: s.enddate,
      })),
      weekdayMultipliers: hotel.weekdaymultipliers ?? {'0':1,'1':1,'2':1,'3':1,'4':1,'5':1.2,'6':1.3},
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao consultar tarifas', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROOT & STATIC ============
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/cleaning-app.html', (req, res) => res.sendFile(path.join(__dirname, 'cleaning-app.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/icon-192.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-192.png')));
app.get('/icon-512.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-512.png')));
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/api/status', (req, res) => res.json({ name: 'LOBBY Backend', status: 'running', mode: 'supabase' }));

// ============ SERVER START ============
const PORT = process.env.PORT || 10000;
seedDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 LOBBY Backend v3 rodando na porta ${PORT}`);
      console.log(`📦 Modo: ${NODE_ENV} (Supabase PostgreSQL)`);
      console.log(`🌍 CORS permitido: ${ALLOWED_ORIGINS.join(', ')}`);
    });
  })
  .catch(err => {
    console.error('❌ Falha ao inicializar banco:', err.message);
    process.exit(1);
  });
