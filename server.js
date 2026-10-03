const crypto = require('crypto');
const express = require('express');
const path = require('path');

// Staff password lets Paul remove anyone. Unset means nobody can remove other people.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const LUNCH_MINUTES = 30;
// Same as MINUTES_PER_MASSAGE in public/app.js.
const MINUTES_PER_MASSAGE = 15;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Storage: Postgres when DATABASE_URL is set (Heroku), otherwise in-memory (local dev).
// Heroku dynos restart daily, so in-memory data would be lost there.
let store;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  store = {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS waitlist (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS remove_token TEXT');
      await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS called_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ');
      // A single row holding when the current lunch break starts and ends (NULL when none is planned).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS lunch (
          id INT PRIMARY KEY CHECK (id = 1),
          until TIMESTAMPTZ
        )`);
      await pool.query('ALTER TABLE lunch ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ');
      await pool.query('INSERT INTO lunch (id, until) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING');
    },
    async getLunch() {
      const { rows } = await pool.query('SELECT starts_at, until FROM lunch WHERE id = 1');
      const row = rows[0];
      if (!row?.until) return null;
      // Lunches saved before starts_at existed began LUNCH_MINUTES before they end.
      const startsAt = row.starts_at || new Date(row.until.getTime() - LUNCH_MINUTES * 60 * 1000);
      return { startsAt: startsAt.toISOString(), until: row.until.toISOString() };
    },
    async setLunch(lunch) {
      await pool.query('UPDATE lunch SET starts_at = $1, until = $2 WHERE id = 1', [
        lunch?.startsAt ?? null,
        lunch?.until ?? null,
      ]);
    },
    async list() {
      const { rows } = await pool.query(
        'SELECT id, name, joined_at AS "joinedAt", called_at AS "calledAt", acked_at AS "ackedAt" FROM waitlist ORDER BY joined_at, id'
      );
      return rows;
    },
    async call(id) {
      // A new call clears any earlier "on the way" reply.
      const { rowCount } = await pool.query(
        'UPDATE waitlist SET called_at = NOW(), acked_at = NULL WHERE id = $1',
        [id]
      );
      return rowCount > 0;
    },
    async ack(id) {
      const { rowCount } = await pool.query(
        'UPDATE waitlist SET acked_at = NOW() WHERE id = $1 AND called_at IS NOT NULL',
        [id]
      );
      return rowCount > 0;
    },
    async add(name, removeToken) {
      const { rows } = await pool.query(
        'INSERT INTO waitlist (name, remove_token) VALUES ($1, $2) RETURNING id, name, joined_at AS "joinedAt"',
        [name, removeToken]
      );
      return rows[0];
    },
    async getRemoveToken(id) {
      const { rows } = await pool.query('SELECT remove_token FROM waitlist WHERE id = $1', [id]);
      return rows.length ? rows[0].remove_token : undefined;
    },
    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM waitlist WHERE id = $1', [id]);
      return rowCount > 0;
    },
  };
} else {
  let entries = [];
  let nextId = 1;
  let lunch = null;

  store = {
    async init() {},
    async getLunch() {
      return lunch;
    },
    async setLunch(value) {
      lunch = value;
    },
    async list() {
      return entries.map(({ id, name, joinedAt, calledAt, ackedAt }) => ({ id, name, joinedAt, calledAt, ackedAt }));
    },
    async call(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return false;
      entry.calledAt = new Date().toISOString();
      entry.ackedAt = null;
      return true;
    },
    async ack(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry || !entry.calledAt) return false;
      entry.ackedAt = new Date().toISOString();
      return true;
    },
    async add(name, removeToken) {
      const entry = { id: nextId++, name, joinedAt: new Date().toISOString(), calledAt: null, ackedAt: null, removeToken };
      entries.push(entry);
      return { id: entry.id, name, joinedAt: entry.joinedAt };
    },
    async getRemoveToken(id) {
      const entry = entries.find((e) => e.id === id);
      return entry ? entry.removeToken : undefined;
    },
    async remove(id) {
      const before = entries.length;
      entries = entries.filter((e) => e.id !== id);
      return entries.length < before;
    },
  };
}

// Constant-time string comparison, so response timing doesn't leak secrets.
function safeEqual(a, b) {
  const hash = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function isAdmin(req) {
  const given = req.get('X-Admin-Password');
  return Boolean(ADMIN_PASSWORD && given && safeEqual(given, ADMIN_PASSWORD));
}

// True if the request carries this entry's secret key, undefined if there's no such entry.
async function ownsEntry(req, id) {
  const token = await store.getRemoveToken(id);
  if (token === undefined) return undefined;
  const given = req.get('X-Remove-Token');
  return Boolean(token && given && safeEqual(given, token));
}

app.post('/api/admin/check', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Wrong password.' });
  res.status(204).end();
});

app.get('/api/waitlist', async (req, res, next) => {
  try {
    res.json(await store.list());
  } catch (err) {
    next(err);
  }
});

// The planned or current lunch break as { startsAt, until }, or null.
// A break that has run out counts as over.
async function activeLunch() {
  const lunch = await store.getLunch();
  return lunch && new Date(lunch.until) > new Date() ? lunch : null;
}

app.get('/api/lunch', async (req, res, next) => {
  try {
    const lunch = await activeLunch();
    res.json({ startsAt: lunch?.startsAt ?? null, until: lunch?.until ?? null });
  } catch (err) {
    next(err);
  }
});

// Staff only: plan a 30-minute lunch break that starts once everyone already
// waiting has had their massage. Nobody new can join from now until it ends.
app.post('/api/lunch', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Staff only.' });
    const waiting = (await store.list()).length;
    const start = Date.now() + waiting * MINUTES_PER_MASSAGE * 60 * 1000;
    const lunch = {
      startsAt: new Date(start).toISOString(),
      until: new Date(start + LUNCH_MINUTES * 60 * 1000).toISOString(),
    };
    await store.setLunch(lunch);
    res.json(lunch);
  } catch (err) {
    next(err);
  }
});

// Staff only: cancel the lunch break or come back early.
app.delete('/api/lunch', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Staff only.' });
    await store.setLunch(null);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.post('/api/waitlist', async (req, res, next) => {
  try {
    if (await activeLunch()) {
      return res.status(409).json({ error: "The list is closed for lunch — please check back soon!" });
    }
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Please enter a name.' });
    // The token is only ever sent to the person who joined; the public list never includes it.
    const removeToken = crypto.randomUUID();
    const entry = await store.add(name, removeToken);
    res.status(201).json({ ...entry, removeToken });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/waitlist/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const owns = await ownsEntry(req, id);
    if (owns === undefined) return res.status(404).json({ error: 'Not found.' });
    if (!owns && !isAdmin(req)) {
      return res.status(403).json({ error: 'You can only remove your own name.' });
    }

    const removed = await store.remove(id);
    if (!removed) return res.status(404).json({ error: 'Not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Staff only: tell someone it's their turn. Their page sees calledAt and pops up an alert.
app.post('/api/waitlist/:id/call', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Staff only.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const called = await store.call(id);
    if (!called) return res.status(404).json({ error: 'Not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// The called person taps "On my way!". Only their own browser (holding the key) can do this.
app.post('/api/waitlist/:id/ack', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const owns = await ownsEntry(req, id);
    if (owns === undefined) return res.status(404).json({ error: 'Not found.' });
    if (!owns) return res.status(403).json({ error: 'You can only reply for yourself.' });
    const acked = await store.ack(id);
    if (!acked) return res.status(409).json({ error: "You haven't been called yet." });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const port = process.env.PORT || 3000;
store.init().then(() => {
  app.listen(port, () => console.log(`Wait list running on port ${port}`));
});
