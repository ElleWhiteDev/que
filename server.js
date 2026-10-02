const express = require('express');
const path = require('path');

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
    },
    async list() {
      const { rows } = await pool.query(
        'SELECT id, name, joined_at AS "joinedAt" FROM waitlist ORDER BY joined_at, id'
      );
      return rows;
    },
    async add(name) {
      const { rows } = await pool.query(
        'INSERT INTO waitlist (name) VALUES ($1) RETURNING id, name, joined_at AS "joinedAt"',
        [name]
      );
      return rows[0];
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
      return entries;
    },
    async add(name) {
      const entry = { id: nextId++, name, joinedAt: new Date().toISOString() };
      entries.push(entry);
      return entry;
    },
    async remove(id) {
      const before = entries.length;
      entries = entries.filter((e) => e.id !== id);
      return entries.length < before;
    },
  };
}

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
    res.status(201).json(await store.add(name));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/waitlist/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const removed = await store.remove(id);
    if (!removed) return res.status(404).json({ error: 'Not found.' });
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
