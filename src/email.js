// ══════════════════════════════════════════════════════════════════════════
// Email Service — Royal Flush Poker
// Handles: email verification, password reset
// Uses nodemailer with SMTP (configure via env vars)
// ══════════════════════════════════════════════════════════════════════════
const nodemailer = require('nodemailer');
const crypto     = require('crypto');

// Token store — PostgreSQL in production, JSON file fallback for local dev
const db   = require('./db');
const fs   = require('fs');
const path = require('path');
const DATA_DIR    = process.env.RAILWAY_ENVIRONMENT
  ? path.join('/tmp', 'rfdata')
  : path.join(__dirname, '../../data');
const TOKENS_FILE = path.join(DATA_DIR, 'email_tokens.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch(_) { return {}; }
}
function saveTokens(t) {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); }
  catch(e) { console.error('[Email] saveTokens failed:', e.message); }
}

// ── SMTP transport ─────────────────────────────────────────────────────────
// Set these env vars on Railway:
//   EMAIL_HOST     e.g. smtp.gmail.com
//   EMAIL_PORT     e.g. 587
//   EMAIL_USER     e.g. noreply@royalflush.io
//   EMAIL_PASS     app password (not your login password)
//   EMAIL_FROM     e.g. "Royal Flush" <noreply@royalflush.io>
//   SITE_URL       e.g. https://royal-flush-frontend.vercel.app

function getTransport() {
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER) {
    // No email configured — log to console in dev
    return null;
  }
  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST,
    port:   parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_PORT === '465',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

const SITE_URL = process.env.SITE_URL || 'https://barrelpoker.com';
const FROM     = process.env.EMAIL_FROM || '"Royal Flush" <noreply@royalflush.io>';
const TOKEN_TTL = 3600000; // 1 hour

// ── Token storage — DB-backed with file fallback ───────────────────────────
async function makeToken(type, userId, email) {
  const token = crypto.randomBytes(32).toString('hex');
  const now   = Date.now();
  try {
    if (db.getPool()) {
      await db.query('DELETE FROM email_tokens WHERE user_id=$1 AND type=$2', [userId, type]);
      await db.query(
        'INSERT INTO email_tokens (token,type,user_id,email,created_at,used) VALUES ($1,$2,$3,$4,$5,false)',
        [token, type, userId, email, now]
      );
      return token;
    }
  } catch(e) {
    console.warn('[Email] DB token save failed, using file fallback:', e.message);
  }
  // Local-dev file fallback
  const tokens = loadTokens();
  Object.keys(tokens).forEach(k => {
    if (tokens[k].userId === userId && tokens[k].type === type) delete tokens[k];
  });
  tokens[token] = { type, userId, email, createdAt: now, used: false };
  saveTokens(tokens);
  return token;
}

async function consumeToken(token, type) {
  try {
    if (db.getPool()) {
      const entry = await db.queryOne('SELECT * FROM email_tokens WHERE token=$1', [token]);
      if (!entry)              return { ok: false, error: 'Invalid or expired link.' };
      if (entry.type !== type) return { ok: false, error: 'Wrong token type.' };
      if (entry.used)          return { ok: false, error: 'This link has already been used.' };
      if (Date.now() - parseInt(entry.created_at) > TOKEN_TTL)
        return { ok: false, error: 'This link has expired. Please request a new one.' };
      await db.query('UPDATE email_tokens SET used=true WHERE token=$1', [token]);
      return { ok: true, userId: entry.user_id, email: entry.email };
    }
  } catch(e) {
    console.warn('[Email] DB token consume failed, using file fallback:', e.message);
  }
  // Local-dev file fallback
  const tokens = loadTokens();
  const entry  = tokens[token];
  if (!entry)              return { ok: false, error: 'Invalid or expired link.' };
  if (entry.type !== type) return { ok: false, error: 'Wrong token type.' };
  if (entry.used)          return { ok: false, error: 'This link has already been used.' };
  if (Date.now() - entry.createdAt > TOKEN_TTL)
    return { ok: false, error: 'This link has expired. Please request a new one.' };
  entry.used = true;
  saveTokens(tokens);
  return { ok: true, userId: entry.userId, email: entry.email };
}

// ── Send email ─────────────────────────────────────────────────────────────
async function sendMail({ to, subject, html, text }) {
  const transport = getTransport();
  if (!transport) {
    // Dev fallback — log to console
    console.log(`\n📧 [EMAIL LOG — no SMTP configured]\nTo: ${to}\nSubject: ${subject}\n${text || html}\n`);
    return { ok: true, dev: true };
  }
  try {
    await transport.sendMail({ from: FROM, to, subject, html, text });
    return { ok: true };
  } catch(e) {
    console.error('[Email] Send error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── EMAIL VERIFICATION ─────────────────────────────────────────────────────
async function sendVerificationEmail(userId, email, username) {
  const token = await makeToken('verify', userId, email);
  const url   = `${SITE_URL}/rf.html?verify=${token}`;
  return sendMail({
    to:      email,
    subject: '✅ Verify your Royal Flush account',
    text:    `Hi ${username},\n\nClick the link below to verify your email:\n${url}\n\nThis link expires in 1 hour.\n\nRoyal Flush Team`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#fff;padding:32px;border-radius:8px">
        <div style="font-size:24px;font-weight:700;margin-bottom:8px">
          <span style="color:#C9A84C">ROYAL</span>FLUSH
        </div>
        <h2 style="font-size:20px;margin:24px 0 8px">Verify your email</h2>
        <p style="color:rgba(255,255,255,0.6);line-height:1.6">Hi ${username}, thanks for signing up! Click below to verify your email address.</p>
        <a href="${url}" style="display:inline-block;margin:24px 0;padding:14px 32px;background:#C9A84C;color:#000;font-weight:700;text-decoration:none;border-radius:4px;letter-spacing:1px">VERIFY EMAIL →</a>
        <p style="color:rgba(255,255,255,0.3);font-size:11px">This link expires in 1 hour. If you didn't sign up, ignore this email.</p>
      </div>`,
  });
}

// ── OTP VERIFICATION ──────────────────────────────────────────────────────
async function sendOTPEmail(userId, email, username, code) {
  return sendMail({
    to:      email,
    subject: `${code} — Your Royal Flush verification code`,
    text:    `Hi ${username},\n\nYour verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nRoyal Flush Team`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#fff;padding:32px;border-radius:8px">
        <div style="font-size:24px;font-weight:700;margin-bottom:8px">
          <span style="color:#C9A84C">ROYAL</span>FLUSH
        </div>
        <h2 style="font-size:20px;margin:24px 0 8px">Verify your email</h2>
        <p style="color:rgba(255,255,255,0.6);line-height:1.6">Hi ${username}, use the code below to verify your account. It expires in 10 minutes.</p>
        <div style="margin:28px 0;text-align:center">
          <span style="display:inline-block;font-size:42px;font-weight:700;letter-spacing:14px;color:#C9A84C;background:rgba(201,168,76,0.08);padding:18px 28px;border-radius:8px;border:1px solid rgba(201,168,76,0.25)">${code}</span>
        </div>
        <p style="color:rgba(255,255,255,0.3);font-size:11px;margin-top:24px">If you didn't sign up for Royal Flush, ignore this email.</p>
      </div>`,
  });
}

// ── PASSWORD RESET ─────────────────────────────────────────────────────────
async function sendPasswordReset(userId, email, username) {
  const token = await makeToken('reset', userId, email);
  const url   = `${SITE_URL}/rf.html?reset=${token}`;
  return sendMail({
    to:      email,
    subject: '🔑 Reset your Royal Flush password',
    text:    `Hi ${username},\n\nClick the link below to reset your password:\n${url}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.\n\nRoyal Flush Team`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#fff;padding:32px;border-radius:8px">
        <div style="font-size:24px;font-weight:700;margin-bottom:8px">
          <span style="color:#C9A84C">ROYAL</span>FLUSH
        </div>
        <h2 style="font-size:20px;margin:24px 0 8px">Reset your password</h2>
        <p style="color:rgba(255,255,255,0.6);line-height:1.6">Hi ${username}, we received a request to reset your password.</p>
        <a href="${url}" style="display:inline-block;margin:24px 0;padding:14px 32px;background:#C9A84C;color:#000;font-weight:700;text-decoration:none;border-radius:4px;letter-spacing:1px">RESET PASSWORD →</a>
        <p style="color:rgba(255,255,255,0.3);font-size:11px">This link expires in 1 hour. If you didn't request this, your account is safe — ignore this email.</p>
      </div>`,
  });
}

module.exports = { sendVerificationEmail, sendOTPEmail, sendPasswordReset, consumeToken, makeToken };
