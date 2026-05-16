// ============================================
// BACKEND LOBBY v2 · Production-Ready
// ============================================
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

// ============ ENV VALIDATION ============

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET inválido. Use uma string aleatória de 32+ caracteres.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL não configurada.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const app = express();

// ============ SECURITY MIDDLEWARE ============

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://lobby-pdv-v2.vercel.app,http://localhost:3000').split(',');(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    callback(new Error('CORS bloqueado: ' + origin));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});

app.use('/api/', apiLimiter);

// ============ DATABASE ============

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PROD ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[DB POOL ERROR]', err.message);
});

// ============ ERROR HELPER ============

function safeError(res, err, context = '') {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  console.error(`[${id}] ${context}:`, err.message);
  if (IS_PROD) {
    return res.status(500).json({ error: 'Erro interno', refId: id });
  }
  return res.status(500).json({ error: err.message, refId: id });
}

// ============ AUTH MIDDLEWARE ============

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
      }
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
};

const enforceHotelOwnership = (req, res, next) => {
  const urlHotelId = req.params.hotelId;
  const tokenHotelId = req.user.hotelId;
  if (urlHotelId && urlHotelId !== tokenHotelId) {
    console.warn(`[IDOR ATTEMPT] User ${req.user.id} tentou acessar hotel ${urlHotelId}`);
    return res.status(403).json({ error: 'Acesso negado a este hotel' });
  }
  next();
};

// ============ VALIDATION SCHEMAS ============

const schemas = {
  login: z.object({
    email: z.string().email().max(120),
    password: z.string().min(6).max(200)
  }),
  guest: z.object({
    cpf: z.string().min(11).max(20),
    name: z.string().min(2).max(120),
    rg: z.string().max(20).optional().nullable(),
    birthDate: z.string().optional().nullable(),
    email: z.string().email().max(120).optional().nullable().or(z.literal('')),
    phone: z.string().max(20).optional().nullable(),
    address: z.string().max(200).optional().nullable(),
    city: z.string().max(80).optional().nullable(),
    state: z.string().max(2).optional().nullable(),
    zipcode: z.string().max(10).optional().nullable()
  }),
  stay: z.object({
    guestId: z.string().uuid(),
    roomId: z.string().uuid(),
    reservationId: z.string().uuid().optional().nullable(),
    numberOfNights: z.number().int().min(1).max(365),
    dailyRate: z.number().positive()
  }),
  room: z.object({
    roomNumber: z.string().max(10),
    roomType: z.string().max(50),
    capacity: z.number().int().min(1).max(20),
    floor: z.number().int().min(0).max(100).optional().nullable(),
    dailyRate: z.number().positive(),
    amenities: z.array(z.string()).optional()
  })
};

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Dados inválidos',
        details: result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))
      });
    }
    req.body = result.data;
    next();
  };
}

// ============ HEALTH CHECK ============

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'db_down' });
  }
});

app.get('/', (req, res) => {
  res.json({ name: 'LOBBY Backend', status: 'running' });
});

// ============ AUTH ROUTES ============

app.post('/api/auth/login', loginLimiter, validate(schemas.login), async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      await bcrypt.compare(password, '$2b$10$invalidplaceholderhashinvalidplaceholder');
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      console.warn(`[FAILED LOGIN] ${email} from ${req.ip}`);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = jwt.sign(
      { id: user.id, hotelId: user.hotelid, role: user.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    await pool.query('UPDATE users SET lastLogin = NOW() WHERE id = $1', [user.id]);

    res.json({
      token,
      expiresIn: 8 * 3600,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        hotelId: user.hotelid
      }
    });
  } catch (err) {
    safeError(res, err, 'login');
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, role, hotelId FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    safeError(res, err, 'auth/me');
  }
});

// ============ HOTELS ============

app.get('/api/hotels/:hotelId', authenticateToken, enforceHotelOwnership, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hotels WHERE id = $1', [req.params.hotelId]);
    res.json(result.rows[0]);
  } catch (err) {
    safeError(res, err, 'getHotel');
  }
});

// ============ ROOMS ============

app.get('/api/hotels/:hotelId/rooms', authenticateToken, enforceHotelOwnership, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM rooms WHERE hotelId = $1 ORDER BY roomNumber ASC',
      [req.params.hotelId]
    );
    res.json(result.rows);
  } catch (err) {
    safeError(res, err, 'getRooms');
  }
});

// ============ GUESTS ============

app.get('/api/hotels/:hotelId/guests', authenticateToken, enforceHotelOwnership, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM guests WHERE hotelId = $1 ORDER BY totalStays DESC LIMIT 200',
      [req.params.hotelId]
    );
    res.json(result.rows);
  } catch (err) {
    safeError(res, err, 'getGuests');
  }
});

app.get('/api/hotels/:hotelId/guests/cpf/:cpf', authenticateToken, enforceHotelOwnership, async (req, res) => {
  try {
    const cleanCpf = req.params.cpf.replace(/\D/g, '');
    if (cleanCpf.length !== 11) return res.status(400).json({ error: 'CPF inválido' });
    const result = await pool.query(
      'SELECT * FROM guests WHERE hotelId = $1 AND cpf = $2',
      [req.params.hotelId, cleanCpf]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Hóspede não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    safeError(res, err, 'getGuestByCpf');
  }
});

app.post('/api/hotels/:hotelId/guests', authenticateToken, enforceHotelOwnership, validate(schemas.guest), async (req, res) => {
  const { cpf, rg, name, birthDate, email, phone, address, city, state, zipcode } = req.body;
  const cleanCpf = cpf.replace(/\D/g, '');

  try {
    const existing = await pool.query(
      'SELECT * FROM guests WHERE hotelId = $1 AND cpf = $2',
      [req.params.hotelId, cleanCpf]
    );

    if (existing.rows.length > 0) {
      const result = await pool.query(
        'UPDATE guests SET name=$1, birthDate=$2, email=$3, phone=$4, address=$5, city=$6, state=$7, zipcode=$8, updatedAt=NOW() WHERE id=$9 RETURNING *',
        [name, birthDate || null, email || null, phone, address, city, state, zipcode, existing.rows[0].id]
      );
      return res.json(result.rows[0]);
    }

    const result = await pool.query(
      'INSERT INTO guests (hotelId, cpf, rg, name, birthDate, email, phone, address, city, state, zipcode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [req.params.hotelId, cleanCpf, rg, name, birthDate || null, email || null, phone, address, city, state, zipcode]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    safeError(res, err, 'createGuest');
  }
});

// ============ STAYS (CHECK-IN / CHECK-OUT) ============

app.post('/api/hotels/:hotelId/stays', authenticateToken, enforceHotelOwnership, validate(schemas.stay), async (req, res) => {
  const { guestId, roomId, reservationId, numberOfNights, dailyRate } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roomCheck = await client.query(
      'SELECT status FROM rooms WHERE id = $1 AND hotelId = $2 FOR UPDATE',
      [roomId, req.params.hotelId]
    );
    if (!roomCheck.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Quarto não encontrado' });
    }
    if (roomCheck.rows[0].status === 'occupied') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Quarto já está ocupado' });
    }

    await client.query(
      'UPDATE rooms SET status = $1, currentGuest = $2 WHERE id = $3',
      ['occupied', guestId, roomId]
    );

    const stayResult = await client.query(
      'INSERT INTO stays (hotelId, guestId, roomId, reservationId, checkInTime, numberOfNights, dailyRate, totalValue, paymentStatus) VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8) RETURNING *',
      [req.params.hotelId, guestId, roomId, reservationId, numberOfNights, dailyRate, numberOfNights * dailyRate, 'pending']
    );

    if (reservationId) {
      await client.query('UPDATE reservations SET status = $1 WHERE id = $2', ['checked-in', reservationId]);
    }

    await client.query('COMMIT');
    res.status(201).json(stayResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    safeError(res, err, 'checkin');
  } finally {
    client.release();
  }
});

app.put('/api/stays/:id/checkout', authenticateToken, async (req, res) => {
  const { paymentMethod, paymentStatus } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const stayResult = await client.query(
      'SELECT * FROM stays WHERE id = $1 AND hotelId = $2',
      [req.params.id, req.user.hotelId]
    );
    if (!stayResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Hospedagem não encontrada' });
    }
    const stay = stayResult.rows[0];

    const result = await client.query(
      'UPDATE stays SET checkOutTime=NOW(), paymentMethod=$1, paymentStatus=$2, updatedAt=NOW() WHERE id=$3 RETURNING *',
      [paymentMethod, paymentStatus, req.params.id]
    );

    await client.query(
      'UPDATE rooms SET status=$1, currentGuest=NULL, checkoutDate=NULL WHERE id=$2',
      ['cleaning', stay.roomid]
    );

    const totalValue = stay.totalvalue || (stay.numberofnights * stay.dailyrate);
    await client.query(
      'UPDATE guests SET totalStays=totalStays+1, totalSpent=totalSpent+$1, vipScore=vipScore+10, lastVisit=NOW() WHERE id=$2',
      [totalValue, stay.guestid]
    );

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    safeError(res, err, 'checkout');
  } finally {
    client.release();
  }
});

app.get('/api/hotels/:hotelId/stays/active/room/:roomId', authenticateToken, enforceHotelOwnership, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, g.name as guestName, g.cpf 
       FROM stays s 
       JOIN guests g ON s.guestId = g.id 
       WHERE s.hotelId = $1 AND s.roomId = $2 AND s.checkOutTime IS NULL 
       ORDER BY s.checkInTime DESC LIMIT 1`,
      [req.params.hotelId, req.params.roomId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Nenhuma hospedagem ativa' });
    res.json(result.rows[0]);
  } catch (err) {
    safeError(res, err, 'getActiveStay');
  }
});

// ============ DASHBOARD ============

app.get('/api/hotels/:hotelId/dashboard/stats', authenticateToken, enforceHotelOwnership, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM rooms WHERE hotelId = $1) as totalRooms,
        (SELECT COUNT(*) FROM rooms WHERE hotelId = $1 AND status = 'occupied') as occupiedRooms,
        (SELECT COUNT(*) FROM rooms WHERE hotelId = $1 AND status = 'available') as availableRooms,
        (SELECT COUNT(*) FROM rooms WHERE hotelId = $1 AND status = 'cleaning') as cleaningRooms,
        (SELECT COUNT(*) FROM reservations WHERE hotelId = $1 AND checkInDate = CURRENT_DATE) as arrivalsToday,
        (SELECT COUNT(*) FROM reservations WHERE hotelId = $1 AND checkOutDate = CURRENT_DATE) as departuresToday,
        (SELECT COALESCE(SUM(totalValue), 0) FROM stays WHERE hotelId = $1 AND DATE(checkInTime) = CURRENT_DATE) as revenueToday,
        (SELECT COALESCE(SUM(totalValue), 0) FROM stays WHERE hotelId = $1 AND DATE(checkInTime) >= CURRENT_DATE - INTERVAL '30 days') as revenueMonth,
        (SELECT COUNT(*) FROM guests WHERE hotelId = $1) as totalGuests
    `, [req.params.hotelId]);
    res.json(result.rows[0]);
  } catch (err) {
    safeError(res, err, 'dashboardStats');
  }
});

// ============ 404 + ERROR HANDLER ============

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

app.use((err, req, res, next) => {
  safeError(res, err, 'unhandled');
});

// ============ START ============

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 LOBBY Backend v2 rodando na porta ${PORT}`);
  console.log(`🔒 Modo: ${NODE_ENV}`);
  console.log(`🌍 CORS permitido: ${allowedOrigins.join(', ')}`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM recebido, fechando pool...');
  await pool.end();
  process.exit(0);
});