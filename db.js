// db.js — acesso ao Supabase via supabase-js (HTTP/HTTPS, sem problemas de IPv6)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qdxssevoobgmrdriytny.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_KEY não configurado no .env');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Conversores de valor ───────────────────────────────────────────────────
const toISOStr  = (v) => { if (!v) return null; if (v instanceof Date) return v.toISOString(); return v; };
const toDateStr = (v) => { if (!v) return null; if (v instanceof Date) return v.toISOString().split('T')[0]; if (typeof v === 'string') return v.includes('T') ? v.split('T')[0] : v; return null; };
const toFloat   = (v) => (v != null ? parseFloat(v) : null);

// ─── FROM_DB: row Postgres (lowercase) → objeto JS (camelCase) ─────────────
const FROM_DB = {
  users: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, email: r.email, password: r.password_hash,
    name: r.name, role: r.role, isActive: r.isactive,
    createdAt: toISOStr(r.createdat), updatedAt: toISOStr(r.updatedat),
  },
  rooms: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, roomNumber: r.roomnumber?.toString(),
    roomType: r.roomtype, status: r.status, capacity: r.capacity,
    dailyRate: toFloat(r.dailyrate), floor: r.floor, amenities: r.amenities,
    createdAt: toISOStr(r.createdat), updatedAt: toISOStr(r.updatedat),
  },
  guests: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, cpf: r.cpf, name: r.name, email: r.email,
    phone: r.phone, address: r.address, city: r.city, state: r.state,
    zipcode: r.zipcode, birthDate: toDateStr(r.birthdate),
    totalStays: r.totalstays || 0, totalSpent: toFloat(r.totalspent) || 0,
    vipScore: r.vipscore || 0, lastVisit: toDateStr(r.lastvisit), notes: r.notes,
    createdAt: toISOStr(r.createdat), updatedAt: toISOStr(r.updatedat),
  },
  stays: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, guestId: r.guestid, roomId: r.roomid,
    numberOfNights: r.numberofnights, dailyRate: toFloat(r.dailyrate),
    checkinTime: toISOStr(r.checkintime), checkoutTime: toISOStr(r.checkouttime),
    extras: toFloat(r.extras) ?? 0, paymentMethod: r.paymentmethod,
    paymentStatus: r.paymentstatus, notes: r.notes,
    createdAt: toISOStr(r.createdat), updatedAt: toISOStr(r.updatedat),
  },
  invoices: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, stayId: r.stayid,
    total: toFloat(r.totalvalue), paymentMethod: r.paymentmethod, status: r.status,
    createdAt: toISOStr(r.createdat), updatedAt: toISOStr(r.updatedat),
  },
  hotels: (r) => !r ? null : {
    id: r.id, name: r.name,
    weekdayMultipliers: r.weekdaymultipliers ?? {'0':1,'1':1,'2':1,'3':1,'4':1,'5':1.2,'6':1.3},
    createdAt: toISOStr(r.createdat), updatedAt: toISOStr(r.updatedat),
  },
  cleaning_staff: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, name: r.name, phone: r.phone,
    pin: r.pin, isActive: r.isactive, createdAt: toISOStr(r.createdat),
  },
  cleaning_tasks: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, roomId: r.roomid, assignedTo: r.assignedto,
    status: r.status, priority: r.priority, estimatedMinutes: r.estimatedminutes,
    actualMinutes: r.actualminutes, notes: r.notes,
    startedAt: toISOStr(r.startedat), completedAt: toISOStr(r.completedat),
    inspectedAt: toISOStr(r.inspectedat), inspectedBy: r.inspectedby,
    createdAt: toISOStr(r.createdat),
  },
  cleaning_inspections: (r) => !r ? null : {
    id: r.id, taskId: r.taskid, score: r.score, notes: r.notes,
    passed: r.passed, createdAt: toISOStr(r.createdat),
  },
  fnrh_records: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, guestId: r.guestid, stayId: r.stayid,
    fullName: r.fullname, documentType: r.documenttype, documentNumber: r.documentnumber,
    documentIssuer: r.documentissuer, documentIssuerState: r.documentissuerstate,
    birthDate: toDateStr(r.birthdate), nationality: r.nationality, gender: r.gender,
    profession: r.profession, addressStreet: r.addressstreet, addressNumber: r.addressnumber,
    addressComplement: r.addresscomplement, addressNeighborhood: r.addressneighborhood,
    addressCity: r.addresscity, addressState: r.addressstate,
    addressZipcode: r.addresszipcode, addressCountry: r.addresscountry,
    arrivalDate: toDateStr(r.arrivaldate), departureDate: toDateStr(r.departuredate),
    transportMethod: r.transportmethod, transportLicense: r.transportlicense,
    originCity: r.origincity, destinationCity: r.destinationcity,
    purpose: r.purpose, exportedToSismatur: r.exportedtosismatur,
    exportedAt: toISOStr(r.exportedat),
    createdAt: toISOStr(r.createdat), updatedAt: toISOStr(r.updatedat),
  },
  seasons: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, name: r.name, type: r.type,
    startDate: toDateStr(r.startdate), endDate: toDateStr(r.enddate),
    priceMultiplier: toFloat(r.pricemultiplier) ?? 1,
    createdAt: toISOStr(r.createdat),
  },
  reservations: (r) => !r ? null : {
    id: r.id, hotelId: r.hotelid, guestId: r.guestid, roomId: r.roomid,
    checkinDate: toDateStr(r.checkindate), checkoutDate: toDateStr(r.checkoutdate),
    numberOfNights: r.numberofnights, numberOfGuests: r.numberofguests,
    channel: r.channel, source: r.source, status: r.status,
    dailyRate: toFloat(r.dailyrate), totalValue: toFloat(r.totalvalue),
    depositPaid: toFloat(r.depositpaid) ?? 0,
    specialRequests: r.specialrequests,
    createdAt: toISOStr(r.createdat), updatedAt: toISOStr(r.updatedat),
  },
};

// ─── buildDbObj: objeto JS (camelCase) → row Postgres (lowercase) ───────────
// Casos especiais onde camelCase.toLowerCase() ≠ nome da coluna
const KEY_OVERRIDES = {
  users:    { password: 'password_hash' },
  invoices: { total: 'totalvalue' },
};

function buildDbObj(table, obj) {
  const overrides = KEY_OVERRIDES[table] || {};
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    result[overrides[k] !== undefined ? overrides[k] : k.toLowerCase()] = v;
  }
  return result;
}

// ─── q: SQL via exec_sql RPC ─────────────────────────────────────────────────
// ⚠️  Use apenas parâmetros escalares: string, number, boolean, Date, null
// Para arrays ou objetos JSONB, use `supabase.from()` diretamente no server.js
async function q(sql, params = []) {
  // Date → ISO string antes de passar ao RPC
  const serialized = params.map(p => (p instanceof Date ? p.toISOString() : p));
  const { data, error } = await supabase.rpc('exec_sql', { sql, params: serialized });
  if (error) throw new Error(`[q] ${error.message} | SQL: ${sql.slice(0, 120)}`);
  return Array.isArray(data) ? data : [];
}

// ─── CRUD helpers ────────────────────────────────────────────────────────────

/** SELECT por id — retorna objeto JS mapeado ou null. */
async function getById(table, id) {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`[getById:${table}] ${error.message}`);
  return FROM_DB[table]?.(data) ?? null;
}

/** INSERT — retorna objeto JS mapeado. */
async function insert(table, obj) {
  const dbObj = buildDbObj(table, obj);
  const { data, error } = await supabase.from(table).insert(dbObj).select().single();
  if (error) throw new Error(`[insert:${table}] ${error.message}`);
  return FROM_DB[table]?.(data) ?? null;
}

/** UPDATE por id — retorna objeto JS mapeado ou null. */
async function update(table, id, updates) {
  const dbObj  = buildDbObj(table, updates);
  const entries = Object.entries(dbObj).filter(([k]) => k !== 'id');
  if (!entries.length) return getById(table, id);
  const updateObj = Object.fromEntries(entries);
  const { data, error } = await supabase.from(table).update(updateObj).eq('id', id).select().single();
  if (error) {
    if (error.code === 'PGRST116') return null; // linha não encontrada
    throw new Error(`[update:${table}] ${error.message}`);
  }
  return FROM_DB[table]?.(data) ?? null;
}

/** DELETE por id. */
async function del(table, id) {
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw new Error(`[del:${table}] ${error.message}`);
}

module.exports = { supabase, q, getById, insert, update, del, FROM_DB, buildDbObj };
