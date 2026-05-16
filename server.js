require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const cors = require('cors');

const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const app = express();

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
  max: 5,
  message: 'Muitas tentativas de login. Tente novamente em 15 minutos.'
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Muitas requisições. Tente novamente mais tarde.'
});

app.use(apiLimiter);

// ============ DATABASE CONNECTION ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PROD ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Pool error:', err);
});

// ============ HEALTH CHECK ============
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'db_down' });
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
      'SELECT id FROM users WHERE id = $1 AND "hotelId" = $2',
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
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
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
      'SELECT id, name, email, "hotelId" FROM users WHERE email = $1 AND password = $2',
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
        (SELECT COUNT(*) FROM rooms WHERE "hotelId" = $1) as totalrooms,
        (SELECT COUNT(*) FROM rooms WHERE "hotelId" = $1 AND status = 'occupied') as occupiedrooms,
        (SELECT COUNT(*) FROM stays WHERE "hotelId" = $1 AND "checkoutTime" IS NULL) as activestays,
        (SELECT COUNT(*) FROM guests WHERE "hotelId" = $1) as totalguests,
        (SELECT COUNT(*) FROM stays WHERE "hotelId" = $1 AND DATE("checkinTime") = CURRENT_DATE) as arrivalstoday,
        (SELECT COUNT(*) FROM stays WHERE "hotelId" = $1 AND DATE("checkoutTime") = CURRENT_DATE) as departurestoday,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE "hotelId" = $1 AND DATE("createdAt") = CURRENT_DATE AND status = 'paid') as revenuetoday,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE "hotelId" = $1 AND "createdAt" >= CURRENT_DATE - INTERVAL '30 days' AND status = 'paid') as revenuemonth
      FROM rooms WHERE "hotelId" = $1 LIMIT 1
    `, [hotelId]);
    
    res.json(stats.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar dashboard', code: 'INTERNAL_ERROR' });
  }
});

// ============ ROUTES: ROOMS ============
app.get('/api/hotels/:hotelId/rooms', verifyToken, enforceHotelOwnership, async (req, res) => {
  const { hotelId } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT id, "roomNumber", status, "roomType", capacity, "dailyRate" FROM rooms WHERE "hotelId" = $1 ORDER BY "roomNumber"',
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
    
    const result = await pool.query(
      'INSERT INTO guests ("hotelId", cpf, name, email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, cpf',
      [hotelId, cpf, name, email || null, phone || null]
    );
    
    res.status(201).json(result.rows[0]);
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
      'SELECT id, cpf, name, email, phone, "totalStays", "totalSpent", "vipScore" FROM guests WHERE "hotelId" = $1 ORDER BY name',
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
      
      // Check room availability
      const roomCheck = await client.query(
        'SELECT status FROM rooms WHERE id = $1 AND "hotelId" = $2 FOR UPDATE',
        [roomId, hotelId]
      );
      
      if (roomCheck.rows.length === 0 || roomCheck.rows[0].status !== 'available') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Quarto não disponível', code: 'ROOM_NOT_AVAILABLE' });
      }
      
      // Create stay
      const stayResult = await client.query(
        `INSERT INTO stays ("hotelId", "guestId", "roomId", "numberOfNights", "dailyRate", "checkinTime")
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, "guestId", "roomId", "numberOfNights", "dailyRate", "checkinTime"`,
        [hotelId, guestId, roomId, numberOfNights, dailyRate]
      );
      
      // Update room status
      await client.query(
        'UPDATE rooms SET status = $1 WHERE id = $2',
        ['occupied', roomId]
      );
      
      await client.query('COMMIT');
      res.status(201).json(stayResult.rows[0]);
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
      `SELECT s.id, s."guestId", g.name as guestname, s."numberOfNights", s."dailyRate", s."checkinTime", s.extras
       FROM stays s
       JOIN guests g ON s."guestId" = g.id
       WHERE s."hotelId" = $1 AND s."roomId" = $2 AND s."checkoutTime" IS NULL
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
      
      // Get stay details
      const stayResult = await client.query(
        'SELECT "hotelId", "roomId", "numberOfNights", "dailyRate", extras FROM stays WHERE id = $1 FOR UPDATE',
        [stayId]
      );
      
      if (stayResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Hospedagem não encontrada', code: 'NOT_FOUND' });
      }
      
      const stay = stayResult.rows[0];
      const total = (stay.numberOfNights * stay.dailyRate) + (stay.extras || 0);
      
      // Update stay
      await client.query(
        'UPDATE stays SET "checkoutTime" = NOW(), "paymentMethod" = $1 WHERE id = $2',
        [paymentMethod, stayId]
      );
      
      // Create invoice
      await client.query(
        `INSERT INTO invoices ("hotelId", "stayId", total, "paymentMethod", status)
         VALUES ($1, $2, $3, $4, $5)`,
        [stay.hotelId, stayId, total, paymentMethod, paymentStatus]
      );
      
      // Update room status
      await client.query(
        'UPDATE rooms SET status = $1 WHERE id = $2',
        ['available', stay.roomId]
      );
      
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
  res.json({ name: 'LOBBY Backend', status: 'running' });
});

// ============ SERVER START ============
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 LOBBY Backend v2 rodando na porta ${PORT}`);
  console.log(`📋 Modo: ${NODE_ENV}`);
  console.log(`🌍 CORS permitido: ${ALLOWED_ORIGINS.join(', ')}`);
});