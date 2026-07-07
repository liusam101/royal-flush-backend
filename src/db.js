// ══════════════════════════════════════════════════════════════════════════
// Database — PostgreSQL connection pool
// Uses DATABASE_URL from Railway environment variables
// Falls back to JSON file if no DB configured (local dev)
// ══════════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    const sslMode = process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false };
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslMode,
    });
    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
    });
    console.log(`[DB] PostgreSQL pool created (SSL: ${sslMode === false ? 'disabled (private network)' : 'enabled, cert validation off'})`);
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
        id             TEXT PRIMARY KEY,
        username       TEXT UNIQUE NOT NULL,
        email          TEXT UNIQUE NOT NULL,
        password_hash  TEXT NOT NULL,
        chips          NUMERIC(12,2) DEFAULT 10.00,
        gold_chips     BIGINT DEFAULT 250000,
        created_at     BIGINT NOT NULL,
        last_login     BIGINT NOT NULL,
        banned         BOOLEAN DEFAULT FALSE,
        email_verified BOOLEAN DEFAULT FALSE,
        hands_played   INT DEFAULT 0,
        hands_won      INT DEFAULT 0,
        total_won      NUMERIC(12,2) DEFAULT 0,
        total_lost     NUMERIC(12,2) DEFAULT 0,
        vpip_count     INT DEFAULT 0,
        vpip_total     INT DEFAULT 0,
        pfr_count      INT DEFAULT 0,
        pfr_total      INT DEFAULT 0,
        showdown_wins  INT DEFAULT 0,
        showdown_total INT DEFAULT 0
      );
      -- Add stats columns to existing tables (safe if already exist)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS hands_played   INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS hands_won      INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_won      NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_lost     NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS vpip_count     INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS vpip_total     INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pfr_count      INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pfr_total      INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS showdown_wins  INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS showdown_total INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code       VARCHAR(6);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires    BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_bonus_day TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_rc_day    TEXT;

      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id),
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payments (
        session_id  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        amount_usd  INT NOT NULL,
        gold_chips  BIGINT NOT NULL,
        royal_chips NUMERIC(12,2) NOT NULL,
        created_at  BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS users_email_idx    ON users(email);
      CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);

      CREATE TABLE IF NOT EXISTS pushed_assets (
        type          TEXT PRIMARY KEY,
        name          TEXT,
        pushed_at     TEXT NOT NULL,
        data_url      TEXT,
        camera_radius TEXT
      );

      CREATE TABLE IF NOT EXISTS email_tokens (
        token      TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        email      TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        used       BOOLEAN DEFAULT FALSE
      );
      -- Required for ON CONFLICT (user_id, type) UPSERT in email.js
      CREATE UNIQUE INDEX IF NOT EXISTS email_tokens_user_type_idx ON email_tokens (user_id, type);

      CREATE TABLE IF NOT EXISTS rg_limits (
        user_id            TEXT PRIMARY KEY,
        deposit_daily      NUMERIC,
        deposit_weekly     NUMERIC,
        deposit_monthly    NUMERIC,
        loss_daily         NUMERIC,
        session_mins       NUMERIC,
        self_excluded      BOOLEAN NOT NULL DEFAULT false,
        self_exclude_until BIGINT,
        cooloff_until      BIGINT,
        reality_check_mins INTEGER NOT NULL DEFAULT 60,
        pending_limits     JSONB NOT NULL DEFAULT 'null',
        deposits           JSONB NOT NULL DEFAULT '[]',
        sessions           JSONB NOT NULL DEFAULT '[]',
        losses             JSONB NOT NULL DEFAULT '[]'
      );
    `);
    console.log('[DB] Tables ready');
    return true;
  } catch(e) {
    console.error('[DB] Init error:', e.message);
    return false;
  }
}

async function withTransaction(fn) {
  const p = getPool();
  if (!p) throw new Error('No database connection');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, queryOne, initDB, getPool, withTransaction };
