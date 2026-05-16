// ============================================
// BACKEND LOBBY · Node.js + Express + PostgreSQL
// ============================================
// npm install express pg dotenv cors bcrypt jsonwebtoken
// npm start

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ============ DATABASE CONNECTION ============

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/lobby_hotel',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => console.error('Unexpected error on idle client', err));

// ============ MIDDLEWARE ============

// Verificar token JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token required' });

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ============ AUTH ROUTES ============

// 1. LOGIN
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) return res.status(401).json({ error: 'User not found' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign(
      { id: user.id, hotelId: user.hotelId, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    // Update lastLogin
    await pool.query('UPDATE users SET lastLogin = NOW() WHERE id = $1', [user.id]);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        hotelId: user.hotelId
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2. REGISTER (admin only)
app.post('/api/auth/register', authenticateToken, async (req, res) => {
  const { email, password, name, role } = req.body;

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can create users' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (hotelId, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.hotelId, email, hashedPassword, name, role]
    );

    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ HOTELS ROUTES ============

// 3. GET HOTEL INFO
app.get('/api/hotels/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hotels WHERE id = $1', [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. UPDATE HOTEL
app.put('/api/hotels/:id', authenticateToken, async (req, res) => {
  const { name, address, city, state, phone, email } = req.body;

  try {
    const result = await pool.query(
      'UPDATE hotels SET name = $1, address = $2, city = $3, state = $4, phone = $5, email = $6, updatedAt = NOW() WHERE id = $7 RETURNING *',
      [name, address, city, state, phone, email, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ROOMS ROUTES ============

// 5. GET ALL ROOMS
app.get('/api/hotels/:hotelId/rooms', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM rooms WHERE hotelId = $1 ORDER BY roomNumber ASC',
      [req.params.hotelId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. CREATE ROOM
app.post('/api/hotels/:hotelId/rooms', authenticateToken, async (req, res) => {
  const { roomNumber, roomType, capacity, floor, dailyRate, amenities } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO rooms (hotelId, roomNumber, roomType, capacity, floor, dailyRate, amenities) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.params.hotelId, roomNumber, roomType, capacity, floor, dailyRate, amenities || []]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. UPDATE ROOM STATUS
app.put('/api/rooms/:id', authenticateToken, async (req, res) => {
  const { status, currentGuest, checkoutDate } = req.body;

  try {
    const result = await pool.query(
      'UPDATE rooms SET status = $1, currentGuest = $2, checkoutDate = $3, updatedAt = NOW() WHERE id = $4 RETURNING *',
      [status, currentGuest, checkoutDate, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ GUESTS ROUTES ============

// 8. GET ALL GUESTS
app.get('/api/hotels/:hotelId/guests', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM guests WHERE hotelId = $1 ORDER BY totalStays DESC',
      [req.params.hotelId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. GET GUEST BY CPF (para auto-preencher check-in)
app.get('/api/hotels/:hotelId/guests/cpf/:cpf', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM guests WHERE hotelId = $1 AND cpf = $2',
      [req.params.hotelId, req.params.cpf.replace(/\D/g, '')]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. CREATE/UPDATE GUEST
app.post('/api/hotels/:hotelId/guests', authenticateToken, async (req, res) => {
  const { cpf, rg, name, birthDate, email, phone, address, city, state, zipcode } = req.body;
  const cleanCpf = cpf ? cpf.replace(/\D/g, '') : null;

  try {
    // Check if guest exists
    const existing = await pool.query(
      'SELECT * FROM guests WHERE hotelId = $1 AND cpf = $2',
      [req.params.hotelId, cleanCpf]
    );

    if (existing.rows.length > 0) {
      // Update existing
      const result = await pool.query(
        'UPDATE guests SET name = $1, birthDate = $2, email = $3, phone = $4, address = $5, city = $6, state = $7, zipcode = $8, updatedAt = NOW() WHERE id = $9 RETURNING *',
        [name, birthDate, email, phone, address, city, state, zipcode, existing.rows[0].id]
      );
      return res.json(result.rows[0]);
    }

    // Create new
    const result = await pool.query(
      'INSERT INTO guests (hotelId, cpf, rg, name, birthDate, email, phone, address, city, state, zipcode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
      [req.params.hotelId, cleanCpf, rg, name, birthDate, email, phone, address, city, state, zipcode]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ RESERVATIONS ROUTES ============

// 11. GET RESERVATIONS
app.get('/api/hotels/:hotelId/reservations', authenticateToken, async (req, res) => {
  const { status, startDate, endDate } = req.query;

  try {
    let query = 'SELECT r.*, g.name as guestName, rm.roomNumber FROM reservations r JOIN guests g ON r.guestId = g.id JOIN rooms rm ON r.roomId = rm.id WHERE r.hotelId = $1';
    let params = [req.params.hotelId];

    if (status) {
      query += ` AND r.status = $${params.length + 1}`;
      params.push(status);
    }

    if (startDate) {
      query += ` AND r.checkInDate >= $${params.length + 1}`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND r.checkOutDate <= $${params.length + 1}`;
      params.push(endDate);
    }

    query += ' ORDER BY r.checkInDate DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. CREATE RESERVATION
app.post('/api/hotels/:hotelId/reservations', authenticateToken, async (req, res) => {
  const { guestId, roomId, checkInDate, checkOutDate, numberOfGuests, channel, totalValue } = req.body;

  try {
    const numberOfNights = new Date(checkOutDate) - new Date(checkInDate);
    const nights = Math.ceil(numberOfNights / (1000 * 60 * 60 * 24));

    // Get room daily rate
    const roomResult = await pool.query('SELECT dailyRate FROM rooms WHERE id = $1', [roomId]);
    const dailyRate = roomResult.rows[0].dailyRate;

    const result = await pool.query(
      'INSERT INTO reservations (hotelId, guestId, roomId, checkInDate, checkOutDate, numberOfNights, numberOfGuests, channel, dailyRate, totalValue, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
      [req.params.hotelId, guestId, roomId, checkInDate, checkOutDate, nights, numberOfGuests, channel, dailyRate, totalValue || (nights * dailyRate), 'confirmed']
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. UPDATE RESERVATION STATUS
app.put('/api/reservations/:id', authenticateToken, async (req, res) => {
  const { status } = req.body;

  try {
    const result = await pool.query(
      'UPDATE reservations SET status = $1, updatedAt = NOW() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CHECK-IN / CHECK-OUT (STAYS) ============

// 14. CREATE STAY (CHECK-IN)
app.post('/api/hotels/:hotelId/stays', authenticateToken, async (req, res) => {
  const { guestId, roomId, reservationId, numberOfNights, dailyRate } = req.body;

  try {
    // Update room status
    await pool.query(
      'UPDATE rooms SET status = $1, currentGuest = $2 WHERE id = $3',
      ['occupied', guestId, roomId]
    );

    // Create stay record
    const result = await pool.query(
      'INSERT INTO stays (hotelId, guestId, roomId, reservationId, checkInTime, numberOfNights, dailyRate, totalValue, paymentStatus) VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8) RETURNING *',
      [req.params.hotelId, guestId, roomId, reservationId, numberOfNights, dailyRate, numberOfNights * dailyRate, 'pending']
    );

    // Update reservation status
    if (reservationId) {
      await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['checked-in', reservationId]);
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 15. COMPLETE STAY (CHECK-OUT)
app.put('/api/stays/:id/checkout', authenticateToken, async (req, res) => {
  const { paymentMethod, paymentStatus } = req.body;

  try {
    const stayResult = await pool.query('SELECT * FROM stays WHERE id = $1', [req.params.id]);
    const stay = stayResult.rows[0];

    // Update stay
    const result = await pool.query(
      'UPDATE stays SET checkOutTime = NOW(), paymentMethod = $1, paymentStatus = $2, updatedAt = NOW() WHERE id = $3 RETURNING *',
      [paymentMethod, paymentStatus, req.params.id]
    );

    // Update room status
    await pool.query(
      'UPDATE rooms SET status = $1, currentGuest = NULL, checkoutDate = NULL WHERE id = $2',
      ['cleaning', stay.roomId]
    );

    // Update guest stats
    await pool.query(
      'UPDATE guests SET totalStays = totalStays + 1, totalSpent = totalSpent + $1, vipScore = vipScore + 10, lastVisit = NOW() WHERE id = $2',
      [stay.totalValue || (stay.numberOfNights * stay.dailyRate), stay.guestId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CONSUMPTION (PDV) ============

// 16. ADD CONSUMPTION
app.post('/api/hotels/:hotelId/consumption', authenticateToken, async (req, res) => {
  const { roomId, stayId, category, item, quantity, unitPrice } = req.body;
  const totalPrice = quantity * unitPrice;

  try {
    const result = await pool.query(
      'INSERT INTO consumption (hotelId, roomId, stayId, category, item, quantity, unitPrice, totalPrice) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [req.params.hotelId, roomId, stayId, category, item, quantity, unitPrice, totalPrice]
    );

    // Add to stay total
    await pool.query(
      'UPDATE stays SET extras = extras + $1 WHERE id = $2',
      [totalPrice, stayId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 17. GET CONSUMPTION BY ROOM
app.get('/api/hotels/:hotelId/consumption/room/:roomId', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM consumption WHERE hotelId = $1 AND roomId = $2 ORDER BY createdAt DESC',
      [req.params.hotelId, req.params.roomId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ INVOICES (NFS-e / FNRH) ============

// 18. CREATE INVOICE
app.post('/api/hotels/:hotelId/invoices', authenticateToken, async (req, res) => {
  const { stayId, guestName, guestCPF, totalValue, invoiceType } = req.body;

  try {
    // Generate invoice number
    const countResult = await pool.query('SELECT COUNT(*) as count FROM invoices WHERE hotelId = $1', [req.params.hotelId]);
    const invoiceNumber = `NFS-${new Date().getFullYear()}-${String(countResult.rows[0].count + 1).padStart(4, '0')}`;

    const result = await pool.query(
      'INSERT INTO invoices (hotelId, stayId, invoiceNumber, invoiceType, guestName, guestCPF, totalValue, issueDate, status) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8) RETURNING *',
      [req.params.hotelId, stayId, invoiceNumber, invoiceType, guestName, guestCPF, totalValue, 'issued']
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ DASHBOARD METRICS ============

// 19. GET DASHBOARD STATS
app.get('/api/hotels/:hotelId/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM rooms WHERE hotelId = $1) as totalRooms,
        (SELECT COUNT(*) FROM rooms WHERE hotelId = $1 AND status = 'occupied') as occupiedRooms,
        (SELECT COUNT(*) FROM reservations WHERE hotelId = $1 AND checkInDate = CURRENT_DATE) as arrivalsToday,
        (SELECT COUNT(*) FROM reservations WHERE hotelId = $1 AND checkOutDate = CURRENT_DATE) as departurestoday,
        (SELECT COALESCE(SUM(totalValue), 0) FROM stays WHERE hotelId = $1 AND DATE(checkInTime) = CURRENT_DATE) as revenueToday,
        (SELECT COALESCE(SUM(totalValue), 0) FROM stays WHERE hotelId = $1 AND DATE(checkInTime) >= CURRENT_DATE - INTERVAL '30 days') as revenueMonth
    `, [req.params.hotelId]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 20. GET OCCUPANCY CHART DATA
app.get('/api/hotels/:hotelId/dashboard/occupancy', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        DATE(checkInTime) as day,
        ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM rooms WHERE hotelId = $1), 1) as occupancyRate
      FROM stays
      WHERE hotelId = $1 AND DATE(checkInTime) >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(checkInTime)
      ORDER BY day ASC
    `, [req.params.hotelId]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 21. GET REVENUE CHART DATA
app.get('/api/hotels/:hotelId/dashboard/revenue', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        DATE(checkInTime) as day,
        COALESCE(SUM(totalValue), 0) as valor
      FROM stays
      WHERE hotelId = $1 AND DATE(checkInTime) >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(checkInTime)
      ORDER BY day ASC
    `, [req.params.hotelId]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ TARIFFS ============

// 22. GET TARIFFS
app.get('/api/hotels/:hotelId/tariffs', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tariffs WHERE hotelId = $1 AND endDate >= CURRENT_DATE ORDER BY startDate DESC',
      [req.params.hotelId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 23. CREATE/UPDATE TARIFF
app.post('/api/hotels/:hotelId/tariffs', authenticateToken, async (req, res) => {
  const { roomType, channel, startDate, endDate, price, minNights } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO tariffs (hotelId, roomType, channel, startDate, endDate, price, minNights) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.params.hotelId, roomType, channel, startDate, endDate, price, minNights || 1]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ INTEGRATIONS ============

// 24. GET INTEGRATIONS
app.get('/api/hotels/:hotelId/integrations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, type, status, lastSyncDate FROM integrations WHERE hotelId = $1',
      [req.params.hotelId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 25. UPDATE INTEGRATION
app.put('/api/integrations/:id', authenticateToken, async (req, res) => {
  const { apiKey, apiSecret, status, syncFrequency } = req.body;

  try {
    const result = await pool.query(
      'UPDATE integrations SET apiKey = $1, apiSecret = $2, status = $3, syncFrequency = $4 WHERE id = $5 RETURNING *',
      [apiKey, apiSecret, status, syncFrequency, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ERROR HANDLING ============

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 LOBBY Backend rodando em http://localhost:${PORT}`);
  console.log(`📦 Database: ${process.env.DATABASE_URL || 'localhost'}`);
});