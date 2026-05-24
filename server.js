require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const cors = require('cors');
const { randomUUID } = require('crypto');

const NODE_ENV = process.env.NODE_ENV || 'development';
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
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"], // necessário para estilos inline do SPA
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:10000')
  .split(',').map(o => o.trim());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const serverOrigin = `${req.protocol}://${req.get('host')}`;
  const allowed = !origin || origin === serverOrigin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*');
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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

// ============ IN-MEMORY STORE (DEMO) ============
const DB = {
  users:               new Map(),
  rooms:               new Map(),
  guests:              new Map(),
  stays:               new Map(),
  invoices:            new Map(),
  // Módulo Governança
  cleaning_staff:      new Map(),
  cleaning_tasks:      new Map(),
  cleaning_inspections:new Map(),
  // Módulo FNRH
  fnrh_records:        new Map(),
  // Módulo Tarifário
  seasons:             new Map(),
  hotels:              new Map(),
};

const find    = (table, fn) => Array.from(DB[table].values()).filter(fn);
const findOne = (table, fn) => Array.from(DB[table].values()).find(fn) ?? null;
const put     = (table, obj) => { DB[table].set(obj.id, obj); return obj; };

// ============ SEED DATA ============
const HOTEL_ID = 'a1b2c3d4-e5f6-4890-a123-456789abcdef';
const USER_ID  = 'b1c2d3e4-f5a6-4890-b456-789abcdef012';
const BCRYPT_ROUNDS = 10;

async function seedDatabase() {
const adminPwHash = await bcrypt.hash('demo123', BCRYPT_ROUNDS);
put('users', { id: USER_ID, hotelId: HOTEL_ID, name: 'Admin Demo', email: 'admin@demo.com', password: adminPwHash });

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
  put('rooms', { id, hotelId: HOTEL_ID, roomNumber: num, status: 'available', roomType: type, capacity: cap, dailyRate: rate });
}

const guestDefs = [
  ['12345678901', 'João Silva',     'joao@email.com',   '11999990001', 3, 2100, 42],
  ['98765432100', 'Maria Oliveira', 'maria@email.com',  '11999990002', 5, 4500, 75],
  ['11122233344', 'Carlos Santos',  'carlos@email.com', '11999990003', 1,  450,  8],
];
let joaoId;
for (const [cpf, name, email, phone, totalStays, totalSpent, vipScore] of guestDefs) {
  const id = randomUUID();
  if (cpf === '12345678901') joaoId = id;
  put('guests', { id, hotelId: HOTEL_ID, cpf, name, email, phone, totalStays, totalSpent, vipScore });
}

// Active stay: João in room 201
const activeStayId = randomUUID();
put('stays', {
  id: activeStayId, hotelId: HOTEL_ID,
  guestId: joaoId, roomId: roomIds['201'],
  numberOfNights: 2, dailyRate: 250,
  checkinTime: new Date(Date.now() - 86400000).toISOString(),
  checkoutTime: null, extras: 0, paymentMethod: null
});
DB.rooms.get(roomIds['201']).status = 'occupied';

// Seed: faxineiras demo
const staffDefs = [
  ['Ana Lima',      '11988880001', '1234'],
  ['Beatriz Costa', '11988880002', '5678'],
  ['Carla Mendes',  '11988880003', '9012'],
];
const staffIds = [];
for (const [name, phone, pin] of staffDefs) {
  const id = randomUUID();
  staffIds.push(id);
  const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
  put('cleaning_staff', { id, hotelId: HOTEL_ID, name, phone, pin: pinHash, isActive: true, createdAt: new Date().toISOString() });
}

// Seed: tarefas demo para quartos disponíveis
const taskSeeds = [
  [roomIds['101'], staffIds[0], 'pending',     'normal', 30],
  [roomIds['102'], staffIds[1], 'in_progress', 'high',   45],
  [roomIds['103'], staffIds[2], 'done',        'normal', 25],
  [roomIds['301'], staffIds[0], 'pending',     'urgent', 60],
];
for (const [roomId, assignedTo, status, priority, estimatedMinutes] of taskSeeds) {
  put('cleaning_tasks', {
    id: randomUUID(), hotelId: HOTEL_ID, roomId, assignedTo, status, priority,
    estimatedMinutes, actualMinutes: status === 'done' ? 28 : null,
    notes: null,
    startedAt: status !== 'pending' ? new Date(Date.now() - 1800000).toISOString() : null,
    completedAt: status === 'done'  ? new Date(Date.now() -  900000).toISOString() : null,
    inspectedAt: null, inspectedBy: null,
    createdAt: new Date().toISOString(),
  });
}

// Seed: hotel demo com multiplicadores por dia da semana
put('hotels', {
  id: HOTEL_ID, name: 'Hotel Demo LOBBY',
  weekdayMultipliers: { '0':1.0,'1':1.0,'2':1.0,'3':1.0,'4':1.0,'5':1.2,'6':1.3 },
});

// Seed: temporadas demo
const seasonSeeds = [
  ['Réveillon',         'peak',    '2026-12-26', '2027-01-02', 2.50],
  ['Carnaval 2027',     'peak',    '2027-02-26', '2027-03-05', 2.20],
  ['Alta Temporada',    'high',    '2026-12-01', '2027-02-28', 1.50],
  ['Baixa Temporada',   'low',     '2026-04-01', '2026-06-30', 0.80],
];
for (const [name, type, startDate, endDate, priceMultiplier] of seasonSeeds) {
  put('seasons', { id: randomUUID(), hotelId: HOTEL_ID, name, type, startDate, endDate, priceMultiplier, createdAt: new Date().toISOString() });
}

// Seed: hospedagens concluídas + invoices para relatórios demo
const D = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const completedStays = [
  // [roomKey, guestIdx, checkinDaysAgo, checkoutDaysAgo, nights, rate, payMethod]
  ['101', 0, 18, 15, 3, 150, 'pix'],
  ['102', 1,  5,  2, 3, 150, 'credit'],
  ['301', 2, 25, 20, 5, 450, 'credit'],
  ['302', 0, 12,  9, 3, 450, 'debit'],
  ['401', 1, 30, 27, 3, 150, 'cash'],
  ['402', 2,  8,  6, 2, 250, 'pix'],
  ['103', 0, 40, 37, 3, 150, 'credit'],
  ['501', 1, 45, 40, 5, 500, 'credit'],
];
const guestIds = Array.from(DB.guests.values()).map(g => g.id);
for (const [roomKey, gIdx, cin, cout, nights, rate, pay] of completedStays) {
  const sid = randomUUID();
  const guestId = guestIds[gIdx] || guestIds[0];
  put('stays', {
    id: sid, hotelId: HOTEL_ID, guestId, roomId: roomIds[roomKey],
    numberOfNights: nights, dailyRate: rate,
    checkinTime: D(cin), checkoutTime: D(cout), extras: 0, paymentMethod: pay,
  });
  put('invoices', {
    id: randomUUID(), hotelId: HOTEL_ID, stayId: sid,
    total: nights * rate, paymentMethod: pay, status: 'paid', createdAt: D(cout),
  });
}

// Seed: FNRH demo para hospedagem ativa do João
put('fnrh_records', {
  id: randomUUID(), hotelId: HOTEL_ID, guestId: joaoId, stayId: activeStayId,
  fullName: 'João Silva', documentType: 'CPF', documentNumber: '12345678901',
  documentIssuer: 'SSP', documentIssuerState: 'SP',
  birthDate: '1985-03-15', nationality: 'Brasileiro', gender: 'M',
  profession: 'Engenheiro',
  addressStreet: 'Rua das Flores', addressNumber: '123', addressComplement: null,
  addressNeighborhood: 'Centro', addressCity: 'São Paulo', addressState: 'SP',
  addressZipcode: '01310-100', addressCountry: 'Brasil',
  arrivalDate: new Date(Date.now() - 86400000).toISOString().split('T')[0],
  departureDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
  transportMethod: 'carro', transportLicense: 'ABC-1234',
  originCity: 'São Paulo', destinationCity: 'Rio de Janeiro',
  purpose: 'turismo',
  exportedToSismatur: false, exportedAt: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

console.log('✅ Demo database pronto — login: admin@demo.com / demo123');
} // fim seedDatabase

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: 'demo', timestamp: new Date().toISOString() });
});

// ============ FUNÇÕES UTILITÁRIAS ============

// Remove acentos e converte para caixa alta (exportação SISMATUR)
function removeAccents(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

// Valida CPF com dígitos verificadores
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

// Formata data YYYY-MM-DD → YYYYMMDD para SISMATUR
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
  cpf: z.string().regex(/^\d{11}$/),
  name: z.string().min(3).max(120),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable()
});
const StaySchema = z.object({
  guestId: z.string().uuid(),
  roomId: z.string().uuid(),
  numberOfNights: z.number().min(1).max(365),
  // dailyRate vem do servidor (room.dailyRate), nunca do cliente
});

// Schemas: Governança
const CleaningStaffSchema = z.object({
  name:  z.string().min(3).max(120),
  pin:   z.string().regex(/^\d{4,6}$/, 'PIN deve ter 4–6 dígitos'),
  phone: z.string().regex(/^[\d\s()\-+]{10,15}$/).optional().nullable(),
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

// Valida que a string YYYY-MM-DD é uma data de calendário real (ano 2000-2100)
function isCalendarDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T12:00:00');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== str) return false;
  const year = d.getFullYear();
  return year >= 2000 && year <= 2100;
}

// Schemas: Tarifário
const SeasonSchema = z.object({
  name:            z.string().min(2).max(100),
  type:            z.enum(['low','regular','high','peak']),
  startDate:       z.string().refine(isCalendarDate, 'startDate inválida (use YYYY-MM-DD)'),
  endDate:         z.string().refine(isCalendarDate, 'endDate inválida (use YYYY-MM-DD)'),
  priceMultiplier: z.number().min(0.5).max(3.0),
}).refine(d => d.endDate > d.startDate, { message: 'endDate deve ser após startDate', path: ['endDate'] });

const WeekdaySchema = z.object({
  '0': z.number().min(0.5).max(3.0),
  '1': z.number().min(0.5).max(3.0),
  '2': z.number().min(0.5).max(3.0),
  '3': z.number().min(0.5).max(3.0),
  '4': z.number().min(0.5).max(3.0),
  '5': z.number().min(0.5).max(3.0),
  '6': z.number().min(0.5).max(3.0),
});

// Schema FNRH — validações cruzadas via superRefine
const FNRHSchema = z.object({
  guestId:              z.string().uuid(),
  stayId:               z.string().uuid(),
  fullName:             z.string().min(3).max(200),
  documentType:         z.enum(['CPF','RG','PASSAPORTE']),
  documentNumber:       z.string().min(5).max(30),
  documentIssuer:       z.string().max(50).optional().nullable(),
  documentIssuerState:  z.string().length(2).optional().nullable(),
  birthDate:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nationality:          z.string().min(2).max(50).default('Brasileiro'),
  gender:               z.enum(['M','F','O']).optional().nullable(),
  profession:           z.string().max(100).optional().nullable(),
  addressStreet:        z.string().min(3).max(200),
  addressNumber:        z.string().max(20).optional().nullable(),
  addressComplement:    z.string().max(100).optional().nullable(),
  addressNeighborhood:  z.string().max(100).optional().nullable(),
  addressCity:          z.string().min(2).max(100),
  addressState:         z.string().length(2).toUpperCase(),
  addressZipcode:       z.string().max(10).optional().nullable(),
  addressCountry:       z.string().max(50).default('Brasil'),
  arrivalDate:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departureDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transportMethod:      z.enum(['carro','onibus','aviao','trem','barco','outro']).optional().nullable(),
  transportLicense:     z.string().max(20).optional().nullable(),
  originCity:           z.string().max(100).optional().nullable(),
  destinationCity:      z.string().max(100).optional().nullable(),
  purpose:              z.enum(['turismo','negocios','evento','saude','estudo','outro']).optional().nullable(),
}).superRefine((d, ctx) => {
  // CPF: valida dígitos verificadores
  if (d.documentType === 'CPF' && !validateCPFDoc(d.documentNumber))
    ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'CPF inválido' });
  // birthDate não pode ser futura
  if (new Date(d.birthDate) > new Date())
    ctx.addIssue({ code: 'custom', path: ['birthDate'], message: 'Data de nascimento não pode ser futura' });
  // arrivalDate < departureDate
  if (d.arrivalDate >= d.departureDate)
    ctx.addIssue({ code: 'custom', path: ['departureDate'], message: 'Data de saída deve ser após a chegada' });
  // UF válida
  if (!VALID_UFS.has(d.addressState.toUpperCase()))
    ctx.addIssue({ code: 'custom', path: ['addressState'], message: 'UF inválida' });
});

// ============ MIDDLEWARE: ENFORCE HOTEL OWNERSHIP ============
function enforceHotelOwnership(req, res, next) {
  const user = DB.users.get(req.user.id);
  if (!user || user.hotelId !== req.params.hotelId)
    return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
  next();
}

// ============ MIDDLEWARE: JWT VERIFY ============
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

// ============ MIDDLEWARE: VERIFY STAFF TOKEN ============
// Valida JWT emitido para faxineiras (role = 'cleaning_staff')
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

// ============ ROUTES: AUTH ============
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const user = findOne('users', u => u.email === email);
    const valid = user && await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Email ou senha inválidos', code: 'INVALID_CREDENTIALS' });
    const token = jwt.sign({ id: user.id, email: user.email, hotelId: user.hotelId }, JWT_SECRET, { expiresIn: '8h' });
    const { password: _, ...safeUser } = user;
    // Cookie httpOnly — inacessível a JS, mitiga XSS
    res.cookie('lobby_token', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000, // 8h
    });
    res.json({ token, user: safeUser });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao fazer login', code: 'INTERNAL_ERROR' });
  }
});

// Refresh: lê o cookie httpOnly e retorna token fresco para uso em memória
// Permite que o SPA recupere a sessão após reload de página sem expor o token
app.post('/api/auth/refresh', (req, res) => {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith('lobby_token='));
  if (!match) return res.status(401).json({ error: 'Sessão expirada', code: 'NO_COOKIE' });
  const cookieToken = match.split('=')[1];
  try {
    const decoded = jwt.verify(cookieToken, JWT_SECRET);
    const user = DB.users.get(decoded.id);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado', code: 'USER_NOT_FOUND' });
    // Emite novo token e renova o cookie
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

// Logout: limpa o cookie httpOnly no servidor
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('lobby_token');
  res.json({ success: true });
});

// ============ ROUTES: DASHBOARD ============
app.get('/api/hotels/:hotelId/dashboard/stats', verifyToken, enforceHotelOwnership, (req, res) => {
  const { hotelId } = req.params;
  const today = new Date().toDateString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rooms    = find('rooms',    r => r.hotelId === hotelId);
  const guests   = find('guests',   g => g.hotelId === hotelId);
  const stays    = find('stays',    s => s.hotelId === hotelId);
  const invoices = find('invoices', i => i.hotelId === hotelId && i.status === 'paid');

  res.json({
    totalrooms:      rooms.length,
    occupiedrooms:   rooms.filter(r => r.status === 'occupied').length,
    activestays:     stays.filter(s => !s.checkoutTime).length,
    totalguests:     guests.length,
    arrivalstoday:   stays.filter(s => new Date(s.checkinTime).toDateString() === today).length,
    departurestoday: stays.filter(s => s.checkoutTime && new Date(s.checkoutTime).toDateString() === today).length,
    revenuetoday:    invoices.filter(i => new Date(i.createdAt).toDateString() === today).reduce((s, i) => s + i.total, 0),
    revenuemonth:    invoices.filter(i => new Date(i.createdAt) >= thirtyDaysAgo).reduce((s, i) => s + i.total, 0),
  });
});

// ============ ROUTES: ROOMS ============
app.get('/api/hotels/:hotelId/rooms', verifyToken, enforceHotelOwnership, (req, res) => {
  const rooms = find('rooms', r => r.hotelId === req.params.hotelId)
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  res.json(rooms);
});

// ============ ROUTES: GUESTS ============
app.post('/api/hotels/:hotelId/guests', verifyToken, enforceHotelOwnership, (req, res) => {
  try {
    const { cpf, name, email, phone } = GuestSchema.parse(req.body);
    const guest = put('guests', {
      id: randomUUID(), hotelId: req.params.hotelId,
      cpf, name, email: email || null, phone: phone || null,
      totalStays: 0, totalSpent: 0, vipScore: 0
    });
    const { hotelId: _, ...out } = guest;
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar hóspede', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/guests', verifyToken, enforceHotelOwnership, (req, res) => {
  const guests = find('guests', g => g.hotelId === req.params.hotelId)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(guests);
});

// ============ ROUTES: STAYS ============
app.post('/api/hotels/:hotelId/stays', verifyToken, enforceHotelOwnership, (req, res) => {
  try {
    const { guestId, roomId, numberOfNights } = StaySchema.parse(req.body);
    const { hotelId } = req.params;
    const room = DB.rooms.get(roomId);
    if (!room || room.hotelId !== hotelId || room.status !== 'available')
      return res.status(400).json({ error: 'Quarto não disponível', code: 'ROOM_NOT_AVAILABLE' });

    const dailyRate = room.dailyRate; // sempre do servidor, nunca do cliente

    const stay = put('stays', {
      id: randomUUID(), hotelId, guestId, roomId,
      numberOfNights, dailyRate,
      checkinTime: new Date().toISOString(),
      checkoutTime: null, extras: 0, paymentMethod: null
    });
    room.status = 'occupied';
    res.status(201).json(stay);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar hospedagem', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/stays/active/room/:roomId', verifyToken, enforceHotelOwnership, (req, res) => {
  const { hotelId, roomId } = req.params;
  const stay = findOne('stays', s => s.hotelId === hotelId && s.roomId === roomId && !s.checkoutTime);
  if (!stay) return res.status(404).json({ error: 'Hospedagem ativa não encontrada', code: 'NOT_FOUND' });
  const guest = DB.guests.get(stay.guestId);
  res.json({ ...stay, guestname: guest?.name });
});

app.put('/api/stays/:stayId/checkout', verifyToken, (req, res) => {
  const { stayId } = req.params;
  const { paymentMethod, paymentStatus } = req.body;
  const stay = DB.stays.get(stayId);
  if (!stay) return res.status(404).json({ error: 'Hospedagem não encontrada', code: 'NOT_FOUND' });
  if (stay.hotelId !== req.user.hotelId)
    return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
  if (stay.checkoutTime)
    return res.status(409).json({ error: 'Checkout já realizado', code: 'ALREADY_CHECKED_OUT' });

  stay.checkoutTime = new Date().toISOString();
  stay.paymentMethod = paymentMethod;
  const total = (stay.numberOfNights * stay.dailyRate) + (stay.extras || 0);

  put('invoices', {
    id: randomUUID(), hotelId: stay.hotelId, stayId, total,
    paymentMethod, status: paymentStatus || 'paid',
    createdAt: new Date().toISOString()
  });

  const room = DB.rooms.get(stay.roomId);
  if (room) room.status = 'available';

  res.json({ success: true, total });
});

// ============ ROUTES: GOVERNANÇA — STAFF ============

// Lista todas as faxineiras do hotel
app.get('/api/hotels/:hotelId/cleaning/staff', verifyToken, enforceHotelOwnership, (req, res) => {
  const staff = find('cleaning_staff', s => s.hotelId === req.params.hotelId)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(staff.map(({ pin, ...s }) => s)); // nunca expõe o PIN
});

// Cria nova faxineira
app.post('/api/hotels/:hotelId/cleaning/staff', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const { name, pin, phone } = CleaningStaffSchema.parse(req.body);
    const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    const staff = put('cleaning_staff', {
      id: randomUUID(), hotelId: req.params.hotelId,
      name, phone: phone || null, pin: pinHash, isActive: true,
      createdAt: new Date().toISOString(),
    });
    const { pin: _, ...out } = staff;
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar faxineira', code: 'INTERNAL_ERROR' });
  }
});

// Atualiza faxineira
app.put('/api/hotels/:hotelId/cleaning/staff/:staffId', verifyToken, enforceHotelOwnership, async (req, res) => {
  try {
    const staff = DB.cleaning_staff.get(req.params.staffId);
    if (!staff || staff.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Faxineira não encontrada', code: 'NOT_FOUND' });
    const updates = CleaningStaffSchema.partial().parse(req.body);
    // Se o PIN foi alterado, hasheia antes de salvar
    if (updates.pin) updates.pin = await bcrypt.hash(updates.pin, BCRYPT_ROUNDS);
    Object.assign(staff, updates);
    const { pin: _, ...out } = staff;
    res.json(out);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao atualizar faxineira', code: 'INTERNAL_ERROR' });
  }
});

// Remove (desativa) faxineira
app.delete('/api/hotels/:hotelId/cleaning/staff/:staffId', verifyToken, enforceHotelOwnership, (req, res) => {
  const staff = DB.cleaning_staff.get(req.params.staffId);
  if (!staff || staff.hotelId !== req.params.hotelId)
    return res.status(404).json({ error: 'Faxineira não encontrada', code: 'NOT_FOUND' });
  staff.isActive = false;
  res.json({ success: true });
});

// ============ ROUTES: GOVERNANÇA — TASKS ============

// Lista tarefas com filtros opcionais: ?status=pending&date=today&staffId=X
app.get('/api/hotels/:hotelId/cleaning/tasks', verifyToken, enforceHotelOwnership, (req, res) => {
  const { hotelId } = req.params;
  const { status, date, staffId } = req.query;
  const todayStr = new Date().toDateString();

  let tasks = find('cleaning_tasks', t => t.hotelId === hotelId);

  if (status)   tasks = tasks.filter(t => t.status === status);
  if (staffId)  tasks = tasks.filter(t => t.assignedTo === staffId);
  if (date === 'today') tasks = tasks.filter(t => new Date(t.createdAt).toDateString() === todayStr);

  // Enriquece com nome do quarto e da faxineira
  const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  const enriched = tasks
    .sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9))
    .map(t => ({
      ...t,
      roomNumber: DB.rooms.get(t.roomId)?.roomNumber,
      staffName:  t.assignedTo ? DB.cleaning_staff.get(t.assignedTo)?.name : null,
    }));

  res.json(enriched);
});

// Cria nova tarefa de limpeza
app.post('/api/hotels/:hotelId/cleaning/tasks', verifyToken, enforceHotelOwnership, (req, res) => {
  try {
    const { roomId, assignedTo, priority, estimatedMinutes, notes } = CleaningTaskSchema.parse(req.body);
    const { hotelId } = req.params;
    const room = DB.rooms.get(roomId);
    if (!room || room.hotelId !== hotelId)
      return res.status(404).json({ error: 'Quarto não encontrado', code: 'NOT_FOUND' });
    if (assignedTo) {
      const staff = DB.cleaning_staff.get(assignedTo);
      if (!staff || staff.hotelId !== hotelId || !staff.isActive)
        return res.status(400).json({ error: 'Faxineira inativa ou inválida', code: 'INVALID_STAFF' });
    }
    const task = put('cleaning_tasks', {
      id: randomUUID(), hotelId, roomId, assignedTo: assignedTo || null,
      status: 'pending', priority, estimatedMinutes, actualMinutes: null,
      notes: notes || null, startedAt: null, completedAt: null,
      inspectedAt: null, inspectedBy: null, createdAt: new Date().toISOString(),
    });
    res.status(201).json(task);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar tarefa', code: 'INTERNAL_ERROR' });
  }
});

// Inicia tarefa
app.put('/api/cleaning/tasks/:taskId/start', verifyToken, (req, res) => {
  const task = DB.cleaning_tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Tarefa não encontrada', code: 'NOT_FOUND' });
  if (task.hotelId !== req.user.hotelId)
    return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
  if (task.status !== 'pending')
    return res.status(400).json({ error: 'Tarefa não está pendente', code: 'INVALID_STATUS' });
  task.status = 'in_progress';
  task.startedAt = new Date().toISOString();
  // Marca quarto como em limpeza
  const room = DB.rooms.get(task.roomId);
  if (room) room.status = 'cleaning';
  res.json(task);
});

// Conclui tarefa
app.put('/api/cleaning/tasks/:taskId/complete', verifyToken, (req, res) => {
  try {
    const task = DB.cleaning_tasks.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Tarefa não encontrada', code: 'NOT_FOUND' });
    if (task.hotelId !== req.user.hotelId)
      return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    if (task.status !== 'in_progress')
      return res.status(400).json({ error: 'Tarefa não está em andamento', code: 'INVALID_STATUS' });
    const { actualMinutes, notes } = CompleteTaskSchema.parse(req.body);
    const now = new Date();
    // Calcula tempo real se não informado mas startedAt existe
    const calcMinutes = actualMinutes ?? (task.startedAt
      ? Math.round((now - new Date(task.startedAt)) / 60000)
      : null);
    task.status = 'done';
    task.completedAt = now.toISOString();
    task.actualMinutes = calcMinutes;
    if (notes) task.notes = notes;
    res.json(task);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao concluir tarefa', code: 'INTERNAL_ERROR' });
  }
});

// Inspeciona tarefa
app.put('/api/cleaning/tasks/:taskId/inspect', verifyToken, (req, res) => {
  try {
    const task = DB.cleaning_tasks.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Tarefa não encontrada', code: 'NOT_FOUND' });
    if (task.hotelId !== req.user.hotelId)
      return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    if (task.status !== 'done')
      return res.status(400).json({ error: 'Tarefa ainda não concluída', code: 'INVALID_STATUS' });
    const { score, notes, passed } = InspectTaskSchema.parse(req.body);

    // Cria registro de inspeção
    put('cleaning_inspections', {
      id: randomUUID(), taskId: task.id, score, notes: notes || null,
      passed, createdAt: new Date().toISOString(),
    });

    task.inspectedAt = new Date().toISOString();
    task.inspectedBy = req.user.id;

    if (passed) {
      task.status = 'inspected';
      const room = DB.rooms.get(task.roomId);
      if (room) room.status = 'available';
    } else {
      // Reprovado: volta para pendente e cria nova tarefa de retorno
      task.status = 'inspection_failed';
      put('cleaning_tasks', {
        id: randomUUID(), hotelId: task.hotelId, roomId: task.roomId,
        assignedTo: task.assignedTo, status: 'pending', priority: 'high',
        estimatedMinutes: task.estimatedMinutes, actualMinutes: null,
        notes: `Retrabalho — inspeção reprovada (nota ${score}/5): ${notes || ''}`,
        startedAt: null, completedAt: null, inspectedAt: null, inspectedBy: null,
        createdAt: new Date().toISOString(),
      });
    }
    res.json({ task, passed });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao inspecionar tarefa', code: 'INTERNAL_ERROR' });
  }
});

// Gera tarefas do dia baseado nos checkouts
app.post('/api/hotels/:hotelId/cleaning/tasks/generate-daily', verifyToken, enforceHotelOwnership, (req, res) => {
  const { hotelId } = req.params;
  const todayStr  = new Date().toDateString();
  const tomorrowStr = new Date(Date.now() + 86400000).toDateString();

  // Quartos com checkout hoje
  const checkoutsToday = find('stays', s =>
    s.hotelId === hotelId && s.checkoutTime &&
    new Date(s.checkoutTime).toDateString() === todayStr
  );

  if (!checkoutsToday.length)
    return res.json({ created: 0, message: 'Nenhum checkout hoje' });

  // Faxineiras ativas para round-robin
  const activeStaff = find('cleaning_staff', s => s.hotelId === hotelId && s.isActive);

  const created = [];
  checkoutsToday.forEach((stay, idx) => {
    // Evita duplicar tarefas já criadas hoje para o mesmo quarto
    const alreadyExists = findOne('cleaning_tasks', t =>
      t.hotelId === hotelId && t.roomId === stay.roomId &&
      new Date(t.createdAt).toDateString() === todayStr &&
      t.status !== 'inspection_failed'
    );
    if (alreadyExists) return;

    // Define prioridade
    const hasCheckinToday     = findOne('stays', s => s.hotelId === hotelId && s.roomId === stay.roomId && !s.checkoutTime && new Date(s.checkinTime).toDateString() === todayStr);
    const hasCheckinTomorrow  = findOne('stays', s => s.hotelId === hotelId && s.roomId === stay.roomId && !s.checkoutTime && new Date(s.checkinTime).toDateString() === tomorrowStr);
    const priority = hasCheckinToday ? 'urgent' : hasCheckinTomorrow ? 'high' : 'normal';

    // Round-robin entre faxineiras
    const assignedTo = activeStaff.length ? activeStaff[idx % activeStaff.length].id : null;

    const task = put('cleaning_tasks', {
      id: randomUUID(), hotelId, roomId: stay.roomId, assignedTo,
      status: 'pending', priority, estimatedMinutes: 30, actualMinutes: null,
      notes: null, startedAt: null, completedAt: null,
      inspectedAt: null, inspectedBy: null, createdAt: new Date().toISOString(),
    });
    created.push(task);
  });

  res.status(201).json({ created: created.length, tasks: created });
});

// ============ ROUTES: GOVERNANÇA — APP FAXINEIRA ============

// Login da faxineira com staffId + PIN
app.post('/api/cleaning/auth/login', loginLimiter, async (req, res) => {
  try {
    const { staffId, pin } = StaffLoginSchema.parse(req.body);
    const staff = DB.cleaning_staff.get(staffId);
    const valid = staff && staff.isActive && await bcrypt.compare(pin, staff.pin);
    if (!valid)
      return res.status(401).json({ error: 'PIN inválido ou conta inativa', code: 'INVALID_CREDENTIALS' });
    const token = jwt.sign(
      { id: staff.id, hotelId: staff.hotelId, name: staff.name, role: 'cleaning_staff' },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    const { pin: _, ...safeStaff } = staff;
    res.json({ token, staff: safeStaff });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro no login', code: 'INTERNAL_ERROR' });
  }
});

// Minhas tarefas (app da faxineira)
app.get('/api/cleaning/my-tasks', verifyStaffToken, (req, res) => {
  const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  const tasks = find('cleaning_tasks', t =>
    t.assignedTo === req.staff.id && ['pending','in_progress'].includes(t.status)
  )
  .sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9))
  .map(t => ({
    ...t,
    roomNumber: DB.rooms.get(t.roomId)?.roomNumber,
    roomType:   DB.rooms.get(t.roomId)?.roomType,
  }));
  res.json(tasks);
});

// ============ ROUTES: TARIFÁRIO DINÂMICO ============

// Lista temporadas do hotel
app.get('/api/hotels/:hotelId/seasons', verifyToken, enforceHotelOwnership, (req, res) => {
  const seasons = find('seasons', s => s.hotelId === req.params.hotelId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  res.json(seasons);
});

// Cria temporada
app.post('/api/hotels/:hotelId/seasons', verifyToken, enforceHotelOwnership, (req, res) => {
  try {
    const data = SeasonSchema.parse(req.body);
    const { hotelId } = req.params;

    // Verifica sobreposição de datas no mesmo tipo
    const overlap = findOne('seasons', s =>
      s.hotelId === hotelId && s.type === data.type &&
      s.startDate < data.endDate && s.endDate > data.startDate
    );
    if (overlap)
      return res.status(409).json({ error: `Sobreposição com temporada "${overlap.name}"`, code: 'DATE_OVERLAP' });

    const season = put('seasons', { id: randomUUID(), hotelId, ...data, createdAt: new Date().toISOString() });
    res.status(201).json(season);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao criar temporada', code: 'INTERNAL_ERROR' });
  }
});

// Atualiza temporada
app.put('/api/hotels/:hotelId/seasons/:seasonId', verifyToken, enforceHotelOwnership, (req, res) => {
  try {
    const season = DB.seasons.get(req.params.seasonId);
    if (!season || season.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Temporada não encontrada', code: 'NOT_FOUND' });

    const updates = SeasonSchema.partial().parse(req.body);
    const merged  = { ...season, ...updates };

    // Revalida datas se alteradas
    if (merged.endDate <= merged.startDate)
      return res.status(400).json({ error: 'endDate deve ser após startDate', code: 'VALIDATION_ERROR' });

    // Verifica sobreposição ignorando a própria temporada
    const overlap = findOne('seasons', s =>
      s.hotelId === req.params.hotelId && s.type === merged.type &&
      s.id !== season.id &&
      s.startDate < merged.endDate && s.endDate > merged.startDate
    );
    if (overlap)
      return res.status(409).json({ error: `Sobreposição com temporada "${overlap.name}"`, code: 'DATE_OVERLAP' });

    Object.assign(season, updates);
    res.json(season);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao atualizar temporada', code: 'INTERNAL_ERROR' });
  }
});

// Remove temporada
app.delete('/api/hotels/:hotelId/seasons/:seasonId', verifyToken, enforceHotelOwnership, (req, res) => {
  const season = DB.seasons.get(req.params.seasonId);
  if (!season || season.hotelId !== req.params.hotelId)
    return res.status(404).json({ error: 'Temporada não encontrada', code: 'NOT_FOUND' });
  DB.seasons.delete(req.params.seasonId);
  res.json({ success: true });
});

// Lê multiplicadores por dia da semana
app.get('/api/hotels/:hotelId/weekday-multipliers', verifyToken, enforceHotelOwnership, (req, res) => {
  const hotel = DB.hotels.get(req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'Hotel não encontrado', code: 'NOT_FOUND' });
  res.json(hotel.weekdayMultipliers);
});

// Atualiza multiplicadores por dia da semana
app.put('/api/hotels/:hotelId/weekday-multipliers', verifyToken, enforceHotelOwnership, (req, res) => {
  try {
    const hotel = DB.hotels.get(req.params.hotelId);
    if (!hotel) return res.status(404).json({ error: 'Hotel não encontrado', code: 'NOT_FOUND' });
    hotel.weekdayMultipliers = WeekdaySchema.parse(req.body);
    res.json(hotel.weekdayMultipliers);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao salvar multiplicadores', code: 'INTERNAL_ERROR' });
  }
});

// Calcula tarifa detalhada por período
app.get('/api/hotels/:hotelId/tariff/calculate', verifyToken, enforceHotelOwnership, (req, res) => {
  const { hotelId } = req.params;
  const { roomId, checkin, checkout } = req.query;

  if (!roomId || !checkin || !checkout)
    return res.status(400).json({ error: 'roomId, checkin e checkout são obrigatórios', code: 'MISSING_PARAMS' });

  const room = DB.rooms.get(roomId);
  if (!room || room.hotelId !== hotelId)
    return res.status(404).json({ error: 'Quarto não encontrado', code: 'NOT_FOUND' });

  const checkinDate  = new Date(checkin  + 'T12:00:00');
  const checkoutDate = new Date(checkout + 'T12:00:00');
  if (isNaN(checkinDate) || isNaN(checkoutDate) || checkinDate >= checkoutDate)
    return res.status(400).json({ error: 'Datas inválidas', code: 'INVALID_DATES' });

  const hotel    = DB.hotels.get(hotelId);
  const wdMult   = hotel?.weekdayMultipliers || { '0':1,'1':1,'2':1,'3':1,'4':1,'5':1,'6':1 };
  const seasons  = find('seasons', s => s.hotelId === hotelId);
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const basePrice = parseFloat(room.dailyRate);

  const breakdown = [];
  let totalPrice  = 0;
  const current   = new Date(checkinDate);

  while (current < checkoutDate) {
    const dateStr = current.toISOString().split('T')[0];
    const dow     = current.getDay(); // 0=domingo

    // Busca a temporada mais específica (maior priceMultiplier) que cobre este dia
    const activeSeason = seasons
      .filter(s => dateStr >= s.startDate && dateStr <= s.endDate)
      .sort((a, b) => b.priceMultiplier - a.priceMultiplier)[0] || null;

    const seasonMultiplier  = activeSeason ? parseFloat(activeSeason.priceMultiplier) : 1.0;
    const weekdayMultiplier = parseFloat(wdMult[String(dow)] ?? 1.0);
    const finalPrice        = parseFloat((basePrice * seasonMultiplier * weekdayMultiplier).toFixed(2));

    breakdown.push({
      date:              dateStr,
      dayOfWeek:         DAY_NAMES[dow],
      season:            activeSeason?.name || null,
      seasonType:        activeSeason?.type || null,
      seasonMultiplier,
      weekdayMultiplier,
      finalPrice,
    });

    totalPrice += finalPrice;
    current.setDate(current.getDate() + 1);
  }

  const totalNights = breakdown.length;
  res.json({
    roomNumber:       room.roomNumber,
    roomType:         room.roomType,
    basePrice,
    totalNights,
    breakdown,
    totalPrice:        parseFloat(totalPrice.toFixed(2)),
    averageNightPrice: parseFloat((totalPrice / totalNights).toFixed(2)),
  });
});



// ============ ROUTES: RELATÓRIOS ============

// Helpers de data para os relatórios
function dateRange(from, to) {
  const dates = [], cur = new Date(from + 'T12:00:00'), end = new Date(to + 'T12:00:00');
  while (cur <= end) { dates.push(cur.toISOString().split('T')[0]); cur.setDate(cur.getDate() + 1); }
  return dates;
}
function prevPeriod(from, to) {
  const f = new Date(from + 'T12:00:00'), t = new Date(to + 'T12:00:00');
  const days = Math.round((t - f) / 86400000);
  const pTo = new Date(f - 86400000), pFrom = new Date(pTo - days * 86400000);
  return { from: pFrom.toISOString().split('T')[0], to: pTo.toISOString().split('T')[0] };
}
function parseReportParams(req, res) {
  const { from, to } = req.query;
  if (!from || !to) { res.status(400).json({ error: 'from e to são obrigatórios (YYYY-MM-DD)', code: 'MISSING_PARAMS' }); return null; }
  if (from > to)    { res.status(400).json({ error: 'from deve ser anterior a to', code: 'INVALID_RANGE' }); return null; }
  return { from, to };
}
// Conta room-nights ocupadas num período
// SQL equiv: SELECT COUNT(*) FROM stays WHERE hotelId=? AND DATE(checkinTime)<=:day AND (checkoutTime IS NULL OR DATE(checkoutTime)>:day) GROUP BY day
function occupiedRoomNightsInPeriod(hotelId, from, to) {
  const stays = find('stays', s => s.hotelId === hotelId);
  const dates = dateRange(from, to);
  let total = 0;
  const byDay = dates.map(date => {
    const occ = stays.filter(s => {
      const cin  = s.checkinTime.split('T')[0];
      const cout = s.checkoutTime ? s.checkoutTime.split('T')[0] : '9999-12-31';
      return cin <= date && cout > date;
    }).length;
    total += occ;
    return { date, occupiedRooms: occ };
  });
  return { total, byDay };
}

// Relatório de ocupação
app.get('/api/hotels/:hotelId/reports/occupancy', verifyToken, enforceHotelOwnership, (req, res) => {
  const p = parseReportParams(req, res); if (!p) return;
  const { hotelId } = req.params;
  const rooms = find('rooms', r => r.hotelId === hotelId);
  const totalRooms = rooms.length;
  const dates = dateRange(p.from, p.to);
  const totalDaysInPeriod = dates.length;

  const { total: occupiedRoomNights, byDay } = occupiedRoomNightsInPeriod(hotelId, p.from, p.to);
  const availableRoomNights = totalRooms * totalDaysInPeriod;
  const occupancyRate = availableRoomNights > 0
    ? parseFloat((occupiedRoomNights / availableRoomNights * 100).toFixed(2)) : 0;

  const prev = prevPeriod(p.from, p.to);
  const { total: prevOcc } = occupiedRoomNightsInPeriod(hotelId, prev.from, prev.to);
  const prevRate = availableRoomNights > 0 ? parseFloat((prevOcc / availableRoomNights * 100).toFixed(2)) : 0;

  res.json({
    period: p, totalRooms, totalDaysInPeriod,
    occupiedRoomNights, availableRoomNights, occupancyRate,
    byDay: byDay.map(d => ({
      ...d, availableRooms: totalRooms,
      rate: totalRooms > 0 ? parseFloat((d.occupiedRooms / totalRooms * 100).toFixed(1)) : 0,
    })),
    comparison: { previousPeriodRate: prevRate, change: parseFloat((occupancyRate - prevRate).toFixed(2)) },
  });
});

// Relatório de receita
// SQL equiv: SELECT SUM(total), paymentMethod, DATE(createdAt) FROM invoices WHERE hotelId=? AND status='paid' AND createdAt BETWEEN ? AND ? GROUP BY paymentMethod, DATE(createdAt)
app.get('/api/hotels/:hotelId/reports/revenue', verifyToken, enforceHotelOwnership, (req, res) => {
  const p = parseReportParams(req, res); if (!p) return;
  const { hotelId } = req.params;

  const invoices = find('invoices', i =>
    i.hotelId === hotelId && i.status === 'paid' &&
    i.createdAt.split('T')[0] >= p.from && i.createdAt.split('T')[0] <= p.to
  );
  const totalRevenue = invoices.reduce((s, i) => s + i.total, 0);

  // Agrupa por forma de pagamento
  const byPaymentMethod = {};
  for (const inv of invoices)
    byPaymentMethod[inv.paymentMethod] = (byPaymentMethod[inv.paymentMethod] || 0) + inv.total;

  // Agrupa por tipo de quarto (join stays → rooms)
  const byRoomType = {};
  for (const inv of invoices) {
    const stay = DB.stays.get(inv.stayId);
    const type = stay ? (DB.rooms.get(stay.roomId)?.roomType || 'outros') : 'outros';
    byRoomType[type] = (byRoomType[type] || 0) + inv.total;
  }

  // Agrupa por dia
  const byDayMap = {};
  for (const inv of invoices) {
    const day = inv.createdAt.split('T')[0];
    byDayMap[day] = (byDayMap[day] || 0) + inv.total;
  }
  const byDay = Object.entries(byDayMap).sort().map(([date, revenue]) => ({ date, revenue: parseFloat(revenue.toFixed(2)) }));

  const rooms = find('rooms', r => r.hotelId === hotelId);
  const dates = dateRange(p.from, p.to);
  const { total: occNights } = occupiedRoomNightsInPeriod(hotelId, p.from, p.to);
  const ADR    = occNights > 0   ? parseFloat((totalRevenue / occNights).toFixed(2)) : 0;
  const revPAR = rooms.length > 0 ? parseFloat((totalRevenue / (rooms.length * dates.length)).toFixed(2)) : 0;

  res.json({
    period: p,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    byPaymentMethod: Object.fromEntries(Object.entries(byPaymentMethod).map(([k,v]) => [k, parseFloat(v.toFixed(2))])),
    byRoomType:      Object.fromEntries(Object.entries(byRoomType).map(([k,v])      => [k, parseFloat(v.toFixed(2))])),
    byDay, averageDailyRate: ADR, revPAR,
  });
});

// Relatório de hóspedes
// SQL equiv: JOIN fnrh_records GROUP BY nationality, addressState, purpose + age bucket CASE
app.get('/api/hotels/:hotelId/reports/guests', verifyToken, enforceHotelOwnership, (req, res) => {
  const p = parseReportParams(req, res); if (!p) return;
  const { hotelId } = req.params;

  const stays = find('stays', s =>
    s.hotelId === hotelId &&
    s.checkinTime.split('T')[0] >= p.from && s.checkinTime.split('T')[0] <= p.to
  );
  const guestIdSet = new Set(stays.map(s => s.guestId));
  const totalGuests = guestIdSet.size;

  const fnrhs = find('fnrh_records', r =>
    r.hotelId === hotelId && r.arrivalDate >= p.from && r.arrivalDate <= p.to
  );

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

  const avgDuration = stays.length > 0
    ? parseFloat((stays.reduce((s, st) => s + st.numberOfNights, 0) / stays.length).toFixed(1)) : 0;
  const vipGuests = find('guests', g => g.hotelId === hotelId && guestIdSet.has(g.id) && (g.vipScore || 0) > 50).length;

  res.json({ period: p, totalGuests, byNationality, byOriginState, byAgeRange: ageRanges, byPurpose, averageStayDuration: avgDuration, vipGuests });
});

// Relatório de performance das faxineiras
// SQL equiv: SELECT assignedTo, COUNT(*), AVG(actualMinutes), AVG(score), SUM(passed)/COUNT(*) FROM cleaning_tasks LEFT JOIN cleaning_inspections GROUP BY assignedTo
app.get('/api/hotels/:hotelId/reports/staff-performance', verifyToken, enforceHotelOwnership, (req, res) => {
  const p = parseReportParams(req, res); if (!p) return;
  const { hotelId } = req.params;

  const staff = find('cleaning_staff', s => s.hotelId === hotelId);
  const result = staff.map(s => {
    const tasks = find('cleaning_tasks', t =>
      t.assignedTo === s.id &&
      ['done','inspected','inspection_failed'].includes(t.status) &&
      t.completedAt && t.completedAt.split('T')[0] >= p.from &&
      t.completedAt.split('T')[0] <= p.to
    );
    const tasksCompleted = tasks.length;
    const avgMin = tasksCompleted > 0
      ? parseFloat((tasks.filter(t => t.actualMinutes).reduce((sum, t) => sum + t.actualMinutes, 0) / tasksCompleted).toFixed(1)) : 0;
    const taskIds = new Set(tasks.map(t => t.id));
    const inspections = find('cleaning_inspections', i => taskIds.has(i.taskId));
    const totalInsp = inspections.length;
    const avgScore  = totalInsp > 0 ? parseFloat((inspections.reduce((s, i) => s + (i.score || 0), 0) / totalInsp).toFixed(1)) : null;
    const passRate  = totalInsp > 0 ? parseFloat((inspections.filter(i => i.passed).length / totalInsp * 100).toFixed(1)) : null;
    return { id: s.id, name: s.name, tasksCompleted, averageMinutes: avgMin, inspectionScore: avgScore, passRate };
  });

  res.json({ period: p, staff: result });
});

// Relatório financeiro consolidado
// SQL equiv: combina SUM(invoices) + ocupação calculada + métricas KPI hoteleiras (ADR, RevPAR)
app.get('/api/hotels/:hotelId/reports/financial', verifyToken, enforceHotelOwnership, (req, res) => {
  const p = parseReportParams(req, res); if (!p) return;
  const { hotelId } = req.params;

  const invoices = find('invoices', i =>
    i.hotelId === hotelId && i.status === 'paid' &&
    i.createdAt.split('T')[0] >= p.from && i.createdAt.split('T')[0] <= p.to
  );
  const revenue   = parseFloat(invoices.reduce((s, i) => s + i.total, 0).toFixed(2));
  const avgTicket = invoices.length > 0 ? parseFloat((revenue / invoices.length).toFixed(2)) : 0;

  const rooms = find('rooms', r => r.hotelId === hotelId);
  const dates = dateRange(p.from, p.to);
  const { total: occNights } = occupiedRoomNightsInPeriod(hotelId, p.from, p.to);
  const availNights = rooms.length * dates.length;
  const occRate = availNights > 0 ? parseFloat((occNights / availNights * 100).toFixed(2)) : 0;
  const ADR     = occNights > 0   ? parseFloat((revenue / occNights).toFixed(2)) : 0;
  const revPAR  = availNights > 0 ? parseFloat((revenue / availNights).toFixed(2)) : 0;

  const prev = prevPeriod(p.from, p.to);
  const prevInv = find('invoices', i =>
    i.hotelId === hotelId && i.status === 'paid' &&
    i.createdAt.split('T')[0] >= prev.from && i.createdAt.split('T')[0] <= prev.to
  );
  const prevRevenue = parseFloat(prevInv.reduce((s, i) => s + i.total, 0).toFixed(2));
  const { total: prevOcc } = occupiedRoomNightsInPeriod(hotelId, prev.from, prev.to);
  const prevOccRate = availNights > 0 ? parseFloat((prevOcc / availNights * 100).toFixed(2)) : 0;

  res.json({
    period: p, revenue, expenses: 0, profit: revenue,
    averageTicket: avgTicket, occupancyRate: occRate, ADR, revPAR,
    comparison: {
      previousPeriod:  prev, previousRevenue: prevRevenue,
      revenueChange:   parseFloat((revenue - prevRevenue).toFixed(2)),
      previousOccRate: prevOccRate,
      occupancyChange: parseFloat((occRate - prevOccRate).toFixed(2)),
    },
  });
});

// Cria registro FNRH
app.post('/api/hotels/:hotelId/fnrh', verifyToken, enforceHotelOwnership, (req, res) => {
  try {
    const data = FNRHSchema.parse(req.body);
    const { hotelId } = req.params;

    // Verifica se stay pertence ao hotel
    const stay = DB.stays.get(data.stayId);
    if (!stay || stay.hotelId !== hotelId)
      return res.status(404).json({ error: 'Hospedagem não encontrada', code: 'NOT_FOUND' });
    // Garante que guestId corresponde ao hóspede da hospedagem
    if (stay.guestId !== data.guestId)
      return res.status(422).json({ error: 'Hóspede não corresponde à hospedagem', code: 'GUEST_STAY_MISMATCH' });

    // Evita duplicata por stayId
    const existing = findOne('fnrh_records', r => r.stayId === data.stayId);
    if (existing)
      return res.status(409).json({ error: 'FNRH já registrado para esta hospedagem', code: 'DUPLICATE', id: existing.id });

    const record = put('fnrh_records', {
      id: randomUUID(), hotelId, ...data,
      exportedToSismatur: false, exportedAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    res.status(201).json(record);
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR', details: err.errors });
    res.status(500).json({ error: 'Erro ao criar FNRH', code: 'INTERNAL_ERROR' });
  }
});

// Lista FNRHs com filtro por mês e exportação pendente — paginado (page/limit)
app.get('/api/hotels/:hotelId/fnrh', verifyToken, enforceHotelOwnership, (req, res) => {
  const { hotelId } = req.params;
  const { month, exported, page = '1', limit = '20' } = req.query;

  let records = find('fnrh_records', r => r.hotelId === hotelId);

  // Filtra por mês (YYYY-MM) comparando arrivalDate
  if (month) records = records.filter(r => r.arrivalDate.startsWith(month));

  // Filtra por status de exportação
  if (exported !== undefined)
    records = records.filter(r => r.exportedToSismatur === (exported === 'true'));

  // Ordena por arrivalDate desc
  records.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));

  // Paginação simples
  const total   = records.length;
  const pageNum = Math.max(1, parseInt(page));
  const lim     = Math.min(100, Math.max(1, parseInt(limit)));
  const data    = records.slice((pageNum - 1) * lim, pageNum * lim);

  res.json({ total, page: pageNum, limit: lim, pages: Math.ceil(total / lim), data });
});

// Edita registro FNRH
app.put('/api/hotels/:hotelId/fnrh/:recordId', verifyToken, enforceHotelOwnership, (req, res) => {
  try {
    const record = DB.fnrh_records.get(req.params.recordId);
    if (!record || record.hotelId !== req.params.hotelId)
      return res.status(404).json({ error: 'Registro não encontrado', code: 'NOT_FOUND' });
    if (record.exportedToSismatur)
      return res.status(400).json({ error: 'Registro já exportado não pode ser editado', code: 'ALREADY_EXPORTED' });

    const updates = FNRHSchema.partial().parse(req.body);
    Object.assign(record, updates, { updatedAt: new Date().toISOString() });
    res.json(record);
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR', details: err.errors });
    res.status(500).json({ error: 'Erro ao editar FNRH', code: 'INTERNAL_ERROR' });
  }
});

// Exporta FNRH no formato SISMATUR (TXT pipe-separated)
app.get('/api/hotels/:hotelId/fnrh/export', verifyToken, enforceHotelOwnership, (req, res) => {
  const { hotelId } = req.params;
  const { month } = req.query;

  let records = find('fnrh_records', r => r.hotelId === hotelId && !r.exportedToSismatur);
  if (month) records = records.filter(r => r.arrivalDate.startsWith(month));

  if (!records.length)
    return res.status(404).json({ error: 'Nenhum registro pendente de exportação', code: 'NOT_FOUND' });

  // Monta linhas no padrão SISMATUR
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

  // Marca como exportados
  const now = new Date().toISOString();
  records.forEach(r => { r.exportedToSismatur = true; r.exportedAt = now; });

  const filename = month
    ? `fnrh_${month.replace('-','')}.txt`
    : `fnrh_${new Date().toISOString().slice(0,7).replace('-','')}.txt`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

// ============ ROOT ============
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/status', (req, res) => res.json({ name: 'LOBBY Backend', status: 'running', mode: 'demo' }));

// ============ SERVER START ============
const PORT = process.env.PORT || 10000;
seedDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 LOBBY Backend v2 rodando na porta ${PORT}`);
    console.log(`📋 Modo: ${NODE_ENV} (in-memory demo)`);
    console.log(`🌍 CORS permitido: ${ALLOWED_ORIGINS.join(', ')}`);
  });
}).catch(err => { console.error('Erro ao inicializar seed:', err); process.exit(1); });
