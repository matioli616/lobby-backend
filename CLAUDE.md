# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # node server.js — serves on port 10000
node server.js     # direct run
```

There are no tests, no build step, and no linter configured. Verify changes by running the server and hitting endpoints with curl.

```bash
# Login and grab token
curl -s -X POST http://localhost:10000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@demo.com","password":"demo123"}'

# Demo hotel ID (seeded at startup)
HOTEL_ID=a1b2c3d4-e5f6-4890-a123-456789abcdef
```

## Architecture

Everything lives in two files:

- **`server.js`** — entire backend (Express app, in-memory DB, seed data, all routes)
- **`index.html`** — entire frontend (vanilla JS SPA, CSS, all UI modules)

### In-Memory Database

All data is stored in a `DB` object of JavaScript `Map`s — **there is no persistent storage**. Data resets on every server restart. The seed data is recreated at startup.

```js
const DB = {
  users, rooms, guests, stays, invoices,
  cleaning_staff, cleaning_tasks, cleaning_inspections,
  fnrh_records, seasons, hotels
}
```

Three helper functions wrap all DB access:
- `find(table, fn)` — filter all records
- `findOne(table, fn)` — find first match
- `put(table, obj)` — upsert by `obj.id`

`migrations.sql` contains the PostgreSQL/Supabase schema for a future persistent backend (v3). It is not used by the current server.

### Auth & Middleware

Two JWT roles, same `JWT_SECRET`:
- **Admin** (`verifyToken`): standard hotel manager, token payload has `{ id, email, hotelId }`
- **Cleaning staff** (`verifyStaffToken`): requires `role === 'cleaning_staff'` in token payload, login via PIN at `/api/cleaning/auth/login`

`enforceHotelOwnership` is a second guard applied after `verifyToken` on most hotel-scoped routes — it checks that `req.user.hotelId === req.params.hotelId`.

### Route Modules

All routes are inline in `server.js`:

| Module | Route prefix |
|--------|-------------|
| Auth | `POST /api/auth/login` |
| Dashboard | `GET /api/hotels/:hotelId/dashboard/stats` |
| Rooms | `GET /api/hotels/:hotelId/rooms` |
| Guests | `GET/POST /api/hotels/:hotelId/guests` |
| Stays / Check-in | `POST /api/hotels/:hotelId/stays` |
| Checkout | `PUT /api/stays/:stayId/checkout` |
| Governança — Staff | `GET/POST/PUT/DELETE /api/hotels/:hotelId/cleaning/staff` |
| Governança — Tasks | `GET/POST /api/hotels/:hotelId/cleaning/tasks` + `PUT /api/cleaning/tasks/:id/start\|complete\|inspect` + generate-daily |
| Governança — App Faxineira | `POST /api/cleaning/auth/login`, `GET /api/cleaning/my-tasks` |
| Tarifário Dinâmico | `GET/POST/PUT/DELETE /api/hotels/:hotelId/seasons` + weekday-multipliers + tariff/calculate |
| FNRH | `GET/POST/PUT /api/hotels/:hotelId/fnrh` + `/fnrh/export` |
| Relatórios | `GET /api/hotels/:hotelId/reports/occupancy\|revenue\|guests\|staff-performance\|financial` |

### Tariff Calculation Logic

`GET /api/hotels/:hotelId/tariff/calculate` iterates day-by-day between checkin and checkout. Per-night price = `room.dailyRate × seasonMultiplier × weekdayMultiplier`. When multiple seasons overlap a day, the one with the highest `priceMultiplier` wins.

### FNRH Export

`GET /api/hotels/:hotelId/fnrh/export` generates a pipe-separated `.txt` file in SISMATUR format. Strings are uppercased and accent-stripped via `removeAccents()`. Exporting marks records as `exportedToSismatur: true` — exported records cannot be edited and won't appear in future exports.

### Cleaning Task State Machine

`pending` → `in_progress` (start) → `done` (complete) → `inspected` (inspect, passed=true)  
                                                        → `inspection_failed` + new `pending` task created (passed=false)

Room status follows task status: `cleaning` while in_progress, `available` when inspected/passed.

### Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `10000` | Server port |
| `JWT_SECRET` | `'lobby-demo-secret-2026'` | JWT signing key |
| `NODE_ENV` | `'development'` | Logged at startup |
| `ALLOWED_ORIGINS` | `'http://localhost:3000,http://localhost:10000'` | CORS allowlist (comma-separated) |

The server always allows requests from its own origin (`req.protocol + req.get('host')`), regardless of `ALLOWED_ORIGINS`.
