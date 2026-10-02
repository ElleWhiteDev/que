const crypto = require('crypto');
const express = require('express');
const path = require('path');

// Staff password lets Paul remove anyone. Unset means nobody can remove other people.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

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
    },
    async list() {
      const { rows } = await pool.query(
        'SELECT id, name, joined_at AS "joinedAt", called_at AS "calledAt" FROM waitlist ORDER BY joined_at, id'
      );
      return rows;
    },
    async call(id) {
      const { rowCount } = await pool.query('UPDATE waitlist SET called_at = NOW() WHERE id = $1', [id]);
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

  store = {
    async init() {},
    async list() {
      return entries.map(({ id, name, joinedAt, calledAt }) => ({ id, name, joinedAt, calledAt }));
    },
    async call(id) {
      const entry = entries.find((e) => e.id === id);
      if (entry) entry.calledAt = new Date().toISOString();
      return Boolean(entry);
    },
    async add(name, removeToken) {
      const entry = { id: nextId++, name, joinedAt: new Date().toISOString(), calledAt: null, removeToken };
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

app.post('/api/waitlist', async (req, res, next) => {
  try {
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
    const token = await store.getRemoveToken(id);
    if (token === undefined) return res.status(404).json({ error: 'Not found.' });

    const given = req.get('X-Remove-Token');
    const ownsEntry = Boolean(token && given && safeEqual(given, token));
    if (!ownsEntry && !isAdmin(req)) {
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const port = process.env.PORT || 3000;
store.init().then(() => {
  app.listen(port, () => console.log(`Wait list running on port ${port}`));
});
