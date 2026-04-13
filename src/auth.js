// ══════════════════════════════════════════════════════════════════════════
// Auth System — Royal Flush Poker
// PostgreSQL-backed with JSON file fallback for local dev
// ══════════════════════════════════════════════════════════════════════════
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const JWT_SECRET  = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY  = '30d';
const SALT_ROUNDS = 12;

// ── Detect which backend to use ────────────────────────────────────────────
let db = null;
let useDB = false;

async function initAuth() {
  if (process.env.DATABASE_URL) {
    db = require('./db');
    useDB = await db.initDB();
  }
  if (!useDB) console.log('[Auth] Using JSON file store (no DATABASE_URL)');
  else        console.log('[Auth] Using PostgreSQL');
}

// ── JSON fallback (local dev) ──────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, '../../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(_) { return {}; }
}
function saveUsers(u) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
}

// ── Shared helpers ─────────────────────────────────────────────────────────
function safeUser(u) {
  return {
    id:        u.id,
    username:  u.username,
    email:     u.email,
    chips:     parseFloat(u.chips || u.chips_royal || 10),
    goldChips: parseInt(u.gold_chips || u.goldChips || 250000),
    createdAt: parseInt(u.created_at || u.createdAt || Date.now()),
    lastLogin: parseInt(u.last_login || u.lastLogin || Date.now()),
    banned:    !!u.banned,
  };
}

function makeToken(id, username) {
  return jwt.sign({ id, username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function validate({ username, email, password }) {
  if (!username || username.length < 3)
    return 'Username must be at least 3 characters.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return 'Please enter a valid email address.';
  if (!password || password.length < 6)
    return 'Password must be at least 6 characters.';
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// REGISTER
// ══════════════════════════════════════════════════════════════════════════
async function register({ username, email, password }) {
  const err = validate({ username, email, password });
  if (err) return { ok: false, error: err };

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const id   = crypto.randomBytes(16).toString('hex');
  const now  = Date.now();

  if (useDB) {
    // Check duplicates
    const existing = await db.queryOne(
      'SELECT id FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2)',
      [username, email]
    );
    if (existing) {
      // Find which one
      const byName = await db.queryOne('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
      return { ok: false, error: byName ? 'Username already taken.' : 'Email already registered.' };
    }
    const row = await db.queryOne(
      `INSERT INTO users (id,username,email,password_hash,chips,gold_chips,created_at,last_login,banned)
       VALUES ($1,$2,$3,$4,10.00,250000,$5,$5,false) RETURNING *`,
      [id, username, email.toLowerCase(), hash, now]
    );
    const token = makeToken(row.id, row.username);
    return { ok: true, token, user: safeUser(row) };
  } else {
    const users = loadUsers();
    if (Object.values(users).find(u=>u.username.toLowerCase()===username.toLowerCase()))
      return { ok: false, error: 'Username already taken.' };
    if (Object.values(users).find(u=>u.email===email.toLowerCase()))
      return { ok: false, error: 'Email already registered.' };
    users[id] = { id, username, email: email.toLowerCase(), passwordHash: hash,
                  chips: 10, goldChips: 250000, createdAt: now, lastLogin: now, banned: false };
    saveUsers(users);
    return { ok: true, token: makeToken(id, username), user: safeUser(users[id]) };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════════════════════════════
async function login({ email, password }) {
  if (!email || !password) return { ok: false, error: 'Please enter your email and password.' };

  let user;
  if (useDB) {
    user = await db.queryOne('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email]);
  } else {
    const users = loadUsers();
    user = Object.values(users).find(u => u.email === email.toLowerCase());
  }

  if (!user) return { ok: false, error: 'No account found with that email.' };
  if (user.banned) return { ok: false, error: 'This account has been suspended.' };

  const hash = user.password_hash || user.passwordHash;
  const match = await bcrypt.compare(password, hash);
  if (!match) return { ok: false, error: 'Incorrect password.' };

  // Update last login
  if (useDB) {
    await db.query('UPDATE users SET last_login=$1 WHERE id=$2', [Date.now(), user.id]);
  } else {
    const users = loadUsers();
    users[user.id].lastLogin = Date.now();
    saveUsers(users);
  }

  return { ok: true, token: makeToken(user.id, user.username), user: safeUser(user) };
}

// ══════════════════════════════════════════════════════════════════════════
// VERIFY TOKEN
// ══════════════════════════════════════════════════════════════════════════
async function verifyTokenAsync(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    let user;
    if (useDB) {
      user = await db.queryOne('SELECT * FROM users WHERE id=$1 AND banned=false', [decoded.id]);
    } else {
      const users = loadUsers();
      const u = users[decoded.id];
      user = u && !u.banned ? u : null;
    }
    return user ? safeUser(user) : null;
  } catch(_) { return null; }
}

function verifyToken(token) {
  // Sync version for non-async contexts (uses local store only)
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (useDB) return decoded; // partial — caller should use verifyTokenAsync
    const users = loadUsers();
    const u = users[decoded.id];
    return u && !u.banned ? safeUser(u) : null;
  } catch(_) { return null; }
}

// ══════════════════════════════════════════════════════════════════════════
// CHIP UPDATES
// ══════════════════════════════════════════════════════════════════════════
async function updateChips(userId, deltaRoyal, deltaGold) {
  if (useDB) {
    if (deltaRoyal) await db.query(
      'UPDATE users SET chips = GREATEST(0, chips + $1) WHERE id=$2', [deltaRoyal, userId]);
    if (deltaGold) await db.query(
      'UPDATE users SET gold_chips = GREATEST(0, gold_chips + $1) WHERE id=$2', [deltaGold, userId]);
  } else {
    const users = loadUsers();
    if (!users[userId]) return false;
    if (deltaRoyal) users[userId].chips     = Math.max(0, (users[userId].chips     || 0) + deltaRoyal);
    if (deltaGold)  users[userId].goldChips = Math.max(0, (users[userId].goldChips || 0) + deltaGold);
    saveUsers(users);
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════
async function getUser(id) {
  if (useDB) {
    const u = await db.queryOne('SELECT * FROM users WHERE id=$1', [id]);
    return u ? safeUser(u) : null;
  }
  const users = loadUsers();
  return users[id] ? safeUser(users[id]) : null;
}

async function banUser(userId) {
  if (useDB) {
    await db.query('UPDATE users SET banned=true WHERE id=$1', [userId]);
  } else {
    const users = loadUsers();
    if (!users[userId]) return false;
    users[userId].banned = true;
    saveUsers(users);
  }
  return true;
}

async function getAllUsers() {
  if (useDB) {
    const rows = await db.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 1000');
    return rows.map(safeUser);
  }
  return Object.values(loadUsers()).map(safeUser);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  const decoded = verifyToken(header.slice(7));
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = decoded;
  next();
}

module.exports = {
  initAuth, register, login, verifyToken, verifyTokenAsync,
  getUser, updateChips, banUser, getAllUsers, authMiddleware, JWT_SECRET
};
