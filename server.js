require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const cors = require('cors');
const { randomUUID } = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'lobby-demo-secret-2026';
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();
app.set('trust proxy', 1);

// ============ SECURITY MIDDLEWARE ============
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lobby-pdv-v2.vercel.app,http://localhost:3000')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*'))
      return callback(null, true);
    callback(new Error('CORS bloqueado: ' + origin));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

// ============ RATE LIMITING ============
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,
  message: 'Muitas tentativas de login. Tente novamente em 15 minutos.' });

// ============ IN-MEMORY STORE (DEMO) ============
const DB = {
  users:    new Map(),
  rooms:    new Map(),
  guests:   new Map(),
  stays:    new Map(),
  invoices: new Map()
};

const find    = (table, fn) => Array.from(DB[table].values()).filter(fn);
const findOne = (table, fn) => Array.from(DB[table].values()).find(fn) ?? null;
const put     = (table, obj) => { DB[table].set(obj.id, obj); return obj; };

// ============ SEED DATA ============
const HOTEL_ID = 'a1b2c3d4-e5f6-4890-a123-456789abcdef';
const USER_ID  = 'b1c2d3e4-f5a6-4890-b456-789abcdef012';

put('users', { id: USER_ID, hotelId: HOTEL_ID, name: 'Admin Demo', email: 'admin@demo.com', password: 'demo123' });

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

console.log('✅ Demo database pronto — login: admin@demo.com / demo123');

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: 'demo', timestamp: new Date().toISOString() });
});

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
  dailyRate: z.number().min(0)
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

// ============ ROUTES: AUTH ============
app.post('/api/auth/login', loginLimiter, (req, res) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const user = findOne('users', u => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ error: 'Email ou senha inválidos', code: 'INVALID_CREDENTIALS' });
    const token = jwt.sign({ id: user.id, email: user.email, hotelId: user.hotelId }, JWT_SECRET, { expiresIn: '8h' });
    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: 'Erro ao fazer login', code: 'INTERNAL_ERROR' });
  }
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
    const { guestId, roomId, numberOfNights, dailyRate } = StaySchema.parse(req.body);
    const { hotelId } = req.params;
    const room = DB.rooms.get(roomId);
    if (!room || room.hotelId !== hotelId || room.status !== 'available')
      return res.status(400).json({ error: 'Quarto não disponível', code: 'ROOM_NOT_AVAILABLE' });

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

// ============ ROOT ============
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/status', (req, res) => res.json({ name: 'LOBBY Backend', status: 'running', mode: 'demo' }));

// ============ SERVER START ============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 LOBBY Backend v2 rodando na porta ${PORT}`);
  console.log(`📋 Modo: ${NODE_ENV} (in-memory demo)`);
  console.log(`🌍 CORS permitido: ${ALLOWED_ORIGINS.join(', ')}`);
});
