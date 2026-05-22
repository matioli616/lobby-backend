require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const cors = require('cors');
const { randomUUID } = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'lobby-demo-secret-2026';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1);

// ============ SECURITY MIDDLEWARE ============
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lobby-pdv-v2.vercel.app,http://localhost:3000').split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
      return callback(null, true);
    }
    callback(new Error('CORS bloqueado: ' + origin));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

// ============ RATE LIMITING ============
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Muitas tentativas de login. Tente novamente em 15 minutos.'
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Muitas requisições. Tente novamente mais tarde.'
});

app.use(apiLimiter);

// ============ DATABASE: SQLITE IN-MEMORY (DEMO) ============
const sqliteDb = new sqlite3.Database(':memory:');

const dbRun = (sql, params = []) => new Promise((resolve, reject) =>
  sqliteDb.run(sql, params, function(err) { err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes }); })
);
const dbAll = (sql, params = []) => new Promise((resolve, reject) =>
  sqliteDb.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []))
);
const dbGet = (sql, params = []) => new Promise((resolve, reject) =>
  sqliteDb.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null))
);

// Converts PostgreSQL syntax → SQLite, expanding $N params correctly
function toSQLite(sql, params = []) {
  const out = [];
  const converted = sql
    .replace(/\$(\d+)/g, (_, n) => { out.push(params[+n - 1]); return '?'; })
    .replace(/CURRENT_DATE\s*-\s*INTERVAL\s*'30\s*days'/gi, "date('now', '-30 days')")
    .replace(/\bNOW\(\)/gi, "datetime('now')")
    .replace(/\bCURRENT_DATE\b/gi, "date('now')")
    .replace(/\bDATE\(("?\w+"?)\)/gi, 'date($1)')
    .replace(/\s+FOR\s+UPDATE\b/gi, '')
    .replace(/\s+RETURNING\s+[\s\S]*$/i, '');
  return { sql: converted, params: out };
}

// Pool-compatible interface for the rest of the routes (unchanged code)
const pool = {
  async query(rawSql, params = []) {
    const { sql, params: p } = toSQLite(rawSql, params);
    if (sql.trim().match(/^SELECT/i)) {
      return { rows: await dbAll(sql, p) };
    }
    await dbRun(sql, p);
    return { rows: [] };
  },
  async connect() {
    let inTx = false;
    const client = {
      async query(rawSql, params = []) {
        const { sql, params: p } = toSQLite(rawSql, params);
        if (/^BEGIN/i.test(sql.trim())) { await dbRun('BEGIN'); inTx = true; return { rows: [] }; }
        if (/^COMMIT/i.test(sql.trim())) { await dbRun('COMMIT'); inTx = false; return { rows: [] }; }
        if (/^ROLLBACK/i.test(sql.trim())) { await dbRun('ROLLBACK'); inTx = false; return { rows: [] }; }
        if (sql.trim().match(/^SELECT/i)) return { rows: await dbAll(sql, p) };
        await dbRun(sql, p);
        return { rows: [] };
      },
      release() { if (inTx) dbRun('ROLLBACK').catch(() => {}); }
    };
    return client;
  }
};

// ============ SCHEMA & SEED DATA ============
const HOTEL_ID = 'demo-hotel-0001-0000-000000000001';
const USER_ID  = 'demo-user--0001-0000-000000000002';

async function initDB() {
  await dbRun(`CREATE TABLE IF NOT EXISTS hotels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, hotelId TEXT NOT NULL,
    name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, hotelId TEXT NOT NULL,
    roomNumber TEXT NOT NULL, status TEXT DEFAULT 'available',
    roomType TEXT, capacity INTEGER DEFAULT 2, dailyRate REAL DEFAULT 0
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS guests (
    id TEXT PRIMARY KEY, hotelId TEXT NOT NULL,
    cpf TEXT NOT NULL, name TEXT NOT NULL,
    email TEXT, phone TEXT,
    totalStays INTEGER DEFAULT 0, totalSpent REAL DEFAULT 0, vipScore INTEGER DEFAULT 0
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS stays (
    id TEXT PRIMARY KEY, hotelId TEXT NOT NULL,
    guestId TEXT NOT NULL, roomId TEXT NOT NULL,
    numberOfNights INTEGER NOT NULL, dailyRate REAL NOT NULL,
    checkinTime TEXT NOT NULL, checkoutTime TEXT,
    extras REAL DEFAULT 0, paymentMethod TEXT
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, hotelId TEXT NOT NULL, stayId TEXT NOT NULL,
    total REAL NOT NULL, paymentMethod TEXT, status TEXT DEFAULT 'paid',
    createdAt TEXT DEFAULT (datetime('now'))
  )`);

  await dbRun(`INSERT OR IGNORE INTO hotels VALUES (?, ?)`, [HOTEL_ID, 'Hotel Demo LOBBY']);
  await dbRun(`INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?, ?)`,
    [USER_ID, HOTEL_ID, 'Admin Demo', 'admin@demo.com', 'demo123']);

  const roomDefs = [
    ['101', 'standard', 2, 150], ['102', 'standard', 2, 150], ['103', 'standard', 2, 150],
    ['201', 'double',   4, 250], ['202', 'double',   4, 250],
    ['301', 'suite',    2, 450], ['302', 'suite',    2, 450],
    ['401', 'standard', 2, 150], ['402', 'double',   4, 250], ['501', 'suite', 2, 500],
  ];
  for (const [num, type, cap, rate] of roomDefs) {
    await dbRun(
      `INSERT OR IGNORE INTO rooms (id, hotelId, roomNumber, status, roomType, capacity, dailyRate) VALUES (?, ?, ?, 'available', ?, ?, ?)`,
      [randomUUID(), HOTEL_ID, num, type, cap, rate]
    );
  }

  const guestDefs = [
    [randomUUID(), '12345678901', 'João Silva',     'joao@email.com',    '11999990001', 3, 2100, 42],
    [randomUUID(), '98765432100', 'Maria Oliveira', 'maria@email.com',   '11999990002', 5, 4500, 75],
    [randomUUID(), '11122233344', 'Carlos Santos',  'carlos@email.com',  '11999990003', 1,  450,  8],
  ];
  for (const [id, cpf, name, email, phone, ts, spent, vip] of guestDefs) {
    await dbRun(
      `INSERT OR IGNORE INTO guests (id, hotelId, cpf, name, email, phone, totalStays, totalSpent, vipScore) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, HOTEL_ID, cpf, name, email, phone, ts, spent, vip]
    );
  }

  // Active stay: João Silva in room 201
  const room201 = await dbGet(`SELECT id FROM rooms WHERE hotelId = ? AND roomNumber = '201'`, [HOTEL_ID]);
  const joao    = await dbGet(`SELECT id FROM rooms WHERE hotelId = ? AND roomNumber = '201'`, [HOTEL_ID]);
  const joaoGuest = await dbGet(`SELECT id FROM guests WHERE hotelId = ? AND cpf = '12345678901'`, [HOTEL_ID]);
  if (room201 && joaoGuest) {
    await dbRun(`INSERT OR IGNORE INTO stays (id, hotelId, guestId, roomId, numberOfNights, dailyRate, checkinTime)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-1 day'))`,
      [randomUUID(), HOTEL_ID, joaoGuest.id, room201.id, 2, 250]);
    await dbRun(`UPDATE rooms SET status = 'occupied' WHERE id = ?`, [room201.id]);
  }

  console.log('✅ Demo database pronto — login: admin@demo.com / demo123');
}

initDB().catch(err => {
  console.error('Erro ao inicializar banco demo:', err);
  process.exit(1);
});

// ============ HEALTH CHECK ============
app.get('/health', async (req, res) => {
  try {
    await dbGet('SELECT 1');
    res.json({ status: 'ok', mode: 'demo-sqlite', timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({ status: 'db_down', detail: err.message });
  }
});

// ============ VALIDATION SCHEMAS ============
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

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
async function enforceHotelOwnership(req, res, next) {
  const hotelId = req.params.hotelId;
  const userId = req.user.id;
  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND hotelId = $2',
      [userId, hotelId]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Acesso negado', code: 'FORBIDDEN' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Erro ao validar acesso', code: 'INTERNAL_ERROR' });
  }
}

// ============ MIDDLEWARE: JWT VERIFY ============
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token ausente', code: 'NO_TOKEN' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
    }
    res.status(401).json({ error: 'Token inválido', code: 'INVALID_TOKEN' });
  }
}

// ============ ROUTES: AUTH ============
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const result = await pool.query(
      'SELECT id, name, email, hotelId FROM users WHERE email = $1 AND password = $2',
      [email, password]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha inválidos', code: 'INVALID_CREDENTIALS' });
    }
    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, hotelId: user.hotelId },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, user });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    }
    res.status(500).json({ error: 'Erro ao fazer login', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: DASHBOARD ============
app.get('/api/hotels/:hotelId/dashboard/stats', verifyToken, enforceHotelOwnership, async (req, res) => {
  const { hotelId } = req.params;
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM rooms WHERE hotelId = $1) as totalrooms,
        (SELECT COUNT(*) FROM rooms WHERE hotelId = $1 AND status = 'occupied') as occupiedrooms,
        (SELECT COUNT(*) FROM stays WHERE hotelId = $1 AND checkoutTime IS NULL) as activestays,
        (SELECT COUNT(*) FROM guests WHERE hotelId = $1) as totalguests,
        (SELECT COUNT(*) FROM stays WHERE hotelId = $1 AND date(checkinTime) = date('now')) as arrivalstoday,
        (SELECT COUNT(*) FROM stays WHERE hotelId = $1 AND date(checkoutTime) = date('now')) as departurestoday,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE hotelId = $1 AND date(createdAt) = date('now') AND status = 'paid') as revenuetoday,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE hotelId = $1 AND createdAt >= date('now', '-30 days') AND status = 'paid') as revenuemonth
      FROM rooms WHERE hotelId = $1 LIMIT 1
    `, [hotelId]);
    res.json(stats.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao carregar dashboard', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: ROOMS ============
app.get('/api/hotels/:hotelId/rooms', verifyToken, enforceHotelOwnership, async (req, res) => {
  const { hotelId } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, roomNumber, status, roomType, capacity, dailyRate FROM rooms WHERE hotelId = $1 ORDER BY roomNumber',
      [hotelId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar quartos', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: GUESTS ============
app.post('/api/hotels/:hotelId/guests', verifyToken, enforceHotelOwnership, async (req, res) => {
  const { hotelId } = req.params;
  try {
    const { cpf, name, email, phone } = GuestSchema.parse(req.body);
    const id = randomUUID();
    await pool.query(
      'INSERT INTO guests (id, hotelId, cpf, name, email, phone) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, hotelId, cpf, name, email || null, phone || null]
    );
    const row = await dbGet('SELECT id, name, email, cpf FROM guests WHERE id = ?', [id]);
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    }
    res.status(500).json({ error: 'Erro ao criar hóspede', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/guests', verifyToken, enforceHotelOwnership, async (req, res) => {
  const { hotelId } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, cpf, name, email, phone, totalStays, totalSpent, vipScore FROM guests WHERE hotelId = $1 ORDER BY name',
      [hotelId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar hóspedes', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: STAYS ============
app.post('/api/hotels/:hotelId/stays', verifyToken, enforceHotelOwnership, async (req, res) => {
  const { hotelId } = req.params;
  try {
    const { guestId, roomId, numberOfNights, dailyRate } = StaySchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const roomCheck = await client.query(
        'SELECT status FROM rooms WHERE id = $1 AND hotelId = $2',
        [roomId, hotelId]
      );
      if (roomCheck.rows.length === 0 || roomCheck.rows[0].status !== 'available') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Quarto não disponível', code: 'ROOM_NOT_AVAILABLE' });
      }
      const stayId = randomUUID();
      await client.query(
        `INSERT INTO stays (id, hotelId, guestId, roomId, numberOfNights, dailyRate, checkinTime)
         VALUES ($1, $2, $3, $4, $5, $6, datetime('now'))`,
        [stayId, hotelId, guestId, roomId, numberOfNights, dailyRate]
      );
      await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['occupied', roomId]);
      await client.query('COMMIT');
      const stay = await dbGet('SELECT id, guestId, roomId, numberOfNights, dailyRate, checkinTime FROM stays WHERE id = ?', [stayId]);
      res.status(201).json(stay);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Dados inválidos', code: 'VALIDATION_ERROR' });
    }
    res.status(500).json({ error: 'Erro ao criar hospedagem', code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/hotels/:hotelId/stays/active/room/:roomId', verifyToken, enforceHotelOwnership, async (req, res) => {
  const { hotelId, roomId } = req.params;
  try {
    const result = await pool.query(
      `SELECT s.id, s.guestId, g.name as guestname, s.numberOfNights, s.dailyRate, s.checkinTime, s.extras
       FROM stays s
       JOIN guests g ON s.guestId = g.id
       WHERE s.hotelId = $1 AND s.roomId = $2 AND s.checkoutTime IS NULL
       LIMIT 1`,
      [hotelId, roomId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hospedagem ativa não encontrada', code: 'NOT_FOUND' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar hospedagem', code: 'INTERNAL_ERROR' });
  }
});

app.put('/api/stays/:stayId/checkout', verifyToken, async (req, res) => {
  const { stayId } = req.params;
  const { paymentMethod, paymentStatus } = req.body;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const stayResult = await client.query(
        'SELECT hotelId, roomId, numberOfNights, dailyRate, extras FROM stays WHERE id = $1',
        [stayId]
      );
      if (stayResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Hospedagem não encontrada', code: 'NOT_FOUND' });
      }
      const stay = stayResult.rows[0];
      const total = (stay.numberOfNights * stay.dailyRate) + (stay.extras || 0);
      await client.query(
        'UPDATE stays SET checkoutTime = datetime(\'now\'), paymentMethod = $1 WHERE id = $2',
        [paymentMethod, stayId]
      );
      await client.query(
        'INSERT INTO invoices (id, hotelId, stayId, total, paymentMethod, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [randomUUID(), stay.hotelId, stayId, total, paymentMethod, paymentStatus]
      );
      await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['available', stay.roomId]);
      await client.query('COMMIT');
      res.json({ success: true, total });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fazer checkout', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROOT ============
app.get('/', (req, res) => {
  res.json({ name: 'LOBBY Backend', status: 'running', mode: 'demo' });
});

// ============ SERVER START ============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 LOBBY Backend v2 rodando na porta ${PORT}`);
  console.log(`📋 Modo: ${NODE_ENV} (SQLite in-memory demo)`);
  console.log(`🌍 CORS permitido: ${ALLOWED_ORIGINS.join(', ')}`);
});
