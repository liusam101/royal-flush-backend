// ══════════════════════════════════════════════════════════════════════════
// Database — PostgreSQL connection pool
// Uses DATABASE_URL from Railway environment variables
// Falls back to JSON file if no DB configured (local dev)
// ══════════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // required for Railway
    });
    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
    });
    console.log('[DB] PostgreSQL pool created');
  }
  return pool;
}

// Run a query — returns rows
async function query(sql, params = []) {
  const p = getPool();
  if (!p) throw new Error('No database connection');
  const result = await p.query(sql, params);
  return result.rows;
}

// Run a query — returns first row or null
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// Initialize tables on startup
async function initDB() {
  const p = getPool();
  if (!p) {
    console.log('[DB] No DATABASE_URL — using JSON file fallback');
    return false;
  }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        chips         NUMERIC(12,2) DEFAULT 10.00,
        gold_chips    BIGINT DEFAULT 250000,
        created_at    BIGINT NOT NULL,
        last_login    BIGINT NOT NULL,
        banned        BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id),
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS users_email_idx    ON users(email);
      CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);
    `);
    console.log('[DB] Tables ready');
    return true;
  } catch(e) {
    console.error('[DB] Init error:', e.message);
    return false;
  }
}

module.exports = { query, queryOne, initDB, getPool };
