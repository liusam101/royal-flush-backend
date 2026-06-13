// ══════════════════════════════════════════════════════════════════════════
// Responsible Gambling — Royal Flush Poker
// Legally required features for real-money gaming:
//   - Deposit limits (daily, weekly, monthly)
//   - Session time limits
//   - Loss limits
//   - Self-exclusion (temporary or permanent)
//   - Reality checks (periodic reminders)
//   - Cooling-off periods
//
// Storage: PostgreSQL primary (persists across Railway restarts), JSON file
// fallback for local dev (no DATABASE_URL).
// ══════════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const DATA_DIR = process.env.RAILWAY_ENVIRONMENT
  ? path.join('/tmp', 'rfdata')
  : path.join(__dirname, '../../data');
const RG_FILE  = path.join(DATA_DIR, 'rg_limits.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}

// ── File fallback helpers ──────────────────────────────────────────────────
function _loadFile() {
  try { return JSON.parse(fs.readFileSync(RG_FILE, 'utf8')); } catch(_) { return {}; }
}
function _saveFile(data) {
  try { fs.writeFileSync(RG_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('[RG] file save failed:', e.message); }
}

// ── Default limits ─────────────────────────────────────────────────────────
const DEFAULT_LIMITS = {
  depositDaily:   null,
  depositWeekly:  null,
  depositMonthly: null,
  lossDaily:      null,
  sessionMins:    null,
  selfExcluded:   false,
  selfExcludeUntil: null,
  cooloffUntil:   null,
  realityCheckMins: 60,
};

function _defaultRG(userId) {
  return { ...DEFAULT_LIMITS, userId, deposits: [], sessions: [], losses: [] };
}

// ── DB row → RG object ─────────────────────────────────────────────────────
function _rowToRG(row, userId) {
  return {
    userId,
    depositDaily:     row.deposit_daily   != null ? parseFloat(row.deposit_daily)   : null,
    depositWeekly:    row.deposit_weekly  != null ? parseFloat(row.deposit_weekly)  : null,
    depositMonthly:   row.deposit_monthly != null ? parseFloat(row.deposit_monthly) : null,
    lossDaily:        row.loss_daily      != null ? parseFloat(row.loss_daily)      : null,
    sessionMins:      row.session_mins    != null ? parseFloat(row.session_mins)    : null,
    selfExcluded:     !!row.self_excluded,
    selfExcludeUntil: row.self_exclude_until ? parseInt(row.self_exclude_until) : null,
    cooloffUntil:     row.cooloff_until   ? parseInt(row.cooloff_until)         : null,
    realityCheckMins: row.reality_check_mins || 60,
    pendingLimits:    row.pending_limits  || null,
    deposits:         row.deposits        || [],
    sessions:         row.sessions        || [],
    losses:           row.losses          || [],
  };
}

// ── Storage ────────────────────────────────────────────────────────────────
async function getUserRG(userId) {
  if (db.getPool()) {
    try {
      const row = await db.queryOne('SELECT * FROM rg_limits WHERE user_id=$1', [userId]);
      if (row) return _rowToRG(row, userId);
      return _defaultRG(userId);
    } catch(e) {
      console.warn('[RG] DB read failed, using file fallback:', e.message);
    }
  }
  const data = _loadFile();
  if (!data[userId]) data[userId] = _defaultRG(userId);
  return data[userId];
}

async function saveUserRG(userId, rg) {
  if (db.getPool()) {
    try {
      await db.query(`
        INSERT INTO rg_limits
          (user_id, deposit_daily, deposit_weekly, deposit_monthly,
           loss_daily, session_mins, self_excluded, self_exclude_until,
           cooloff_until, reality_check_mins, pending_limits,
           deposits, sessions, losses)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (user_id) DO UPDATE SET
          deposit_daily      = EXCLUDED.deposit_daily,
          deposit_weekly     = EXCLUDED.deposit_weekly,
          deposit_monthly    = EXCLUDED.deposit_monthly,
          loss_daily         = EXCLUDED.loss_daily,
          session_mins       = EXCLUDED.session_mins,
          self_excluded      = EXCLUDED.self_excluded,
          self_exclude_until = EXCLUDED.self_exclude_until,
          cooloff_until      = EXCLUDED.cooloff_until,
          reality_check_mins = EXCLUDED.reality_check_mins,
          pending_limits     = EXCLUDED.pending_limits,
          deposits           = EXCLUDED.deposits,
          sessions           = EXCLUDED.sessions,
          losses             = EXCLUDED.losses
      `, [
        userId,
        rg.depositDaily, rg.depositWeekly, rg.depositMonthly,
        rg.lossDaily, rg.sessionMins,
        !!rg.selfExcluded,
        rg.selfExcludeUntil || null,
        rg.cooloffUntil     || null,
        rg.realityCheckMins || 60,
        JSON.stringify(rg.pendingLimits || null),
        JSON.stringify(rg.deposits  || []),
        JSON.stringify(rg.sessions  || []),
        JSON.stringify(rg.losses    || []),
      ]);
      return;
    } catch(e) {
      console.warn('[RG] DB write failed, using file fallback:', e.message);
    }
  }
  const data = _loadFile();
  data[userId] = rg;
  _saveFile(data);
}

// ── Check if user can play ─────────────────────────────────────────────────
async function checkRGLimits(userId, buyInAmount) {
  if (!userId) return { ok: true }; // guest — no limits
  const rg  = await getUserRG(userId);
  const now = Date.now();

  // Self-exclusion
  if (rg.selfExcluded) {
    if (rg.selfExcludeUntil && now > rg.selfExcludeUntil) {
      rg.selfExcluded = false; rg.selfExcludeUntil = null;
      await saveUserRG(userId, rg);
    } else {
      const until = rg.selfExcludeUntil
        ? `until ${new Date(rg.selfExcludeUntil).toLocaleDateString()}`
        : 'permanently';
      return { ok: false, error: `Your account is self-excluded ${until}. Contact support to appeal.` };
    }
  }

  // Cooling-off period
  if (rg.cooloffUntil && now < rg.cooloffUntil) {
    const hrs = Math.ceil((rg.cooloffUntil - now) / 3600000);
    return { ok: false, error: `Cooling-off period active — ${hrs} hour(s) remaining.` };
  }

  // Deposit/buy-in limits
  if (buyInAmount > 0) {
    const day   = 86400000, week = 604800000, month = 2592000000;
    const depDay   = rg.deposits.filter(d=>now-d.ts<day  ).reduce((a,d)=>a+d.amount,0);
    const depWeek  = rg.deposits.filter(d=>now-d.ts<week ).reduce((a,d)=>a+d.amount,0);
    const depMonth = rg.deposits.filter(d=>now-d.ts<month).reduce((a,d)=>a+d.amount,0);

    if (rg.depositDaily   !== null && depDay   + buyInAmount > rg.depositDaily)
      return { ok: false, error: `Daily deposit limit reached ($${rg.depositDaily}). Resets tomorrow.` };
    if (rg.depositWeekly  !== null && depWeek  + buyInAmount > rg.depositWeekly)
      return { ok: false, error: `Weekly deposit limit reached ($${rg.depositWeekly}).` };
    if (rg.depositMonthly !== null && depMonth + buyInAmount > rg.depositMonthly)
      return { ok: false, error: `Monthly deposit limit reached ($${rg.depositMonthly}).` };

    // Loss limit — check today's losses BEFORE allowing buy-in
    if (rg.lossDaily !== null) {
      const lostToday = rg.losses.filter(l=>now-l.ts<day).reduce((a,l)=>a+l.amount,0);
      if (lostToday >= rg.lossDaily)
        return { ok: false, error: `Daily loss limit of $${rg.lossDaily} reached. Come back tomorrow.` };
    }

    // All checks passed — record this buy-in as a deposit
    rg.deposits.push({ ts: now, amount: buyInAmount });
    if (rg.deposits.length > 1000) rg.deposits = rg.deposits.slice(-1000);
    await saveUserRG(userId, rg);
  }

  return { ok: true };
}

// ── Record a loss ─────────────────────────────────────────────────────────
async function recordLoss(userId, amount) {
  if (!userId || amount <= 0) return;
  const rg = await getUserRG(userId);
  rg.losses.push({ ts: Date.now(), amount });
  if (rg.losses.length > 1000) rg.losses = rg.losses.slice(-1000);
  await saveUserRG(userId, rg);
}

// ── Session tracking ───────────────────────────────────────────────────────
const activeSessions = {}; // userId → { startTs, tableId }

function startSession(userId, tableId) {
  if (!userId) return;
  activeSessions[userId] = { startTs: Date.now(), tableId };
}

async function endSession(userId) {
  if (!userId || !activeSessions[userId]) return;
  const sess = activeSessions[userId];
  const dur  = Math.floor((Date.now() - sess.startTs) / 60000);
  const rg   = await getUserRG(userId);
  rg.sessions.push({ ts: sess.startTs, durationMins: dur });
  if (rg.sessions.length > 500) rg.sessions = rg.sessions.slice(-500);
  await saveUserRG(userId, rg);
  delete activeSessions[userId];
}

function checkSessionLimit(userId) {
  if (!userId || !activeSessions[userId]) return { ok: true };
  // sessionMins checked synchronously against in-memory start time.
  // We still need the limit from DB, so callers that need this should
  // use checkSessionLimitAsync instead.
  return { ok: true };
}

async function checkSessionLimitAsync(userId) {
  if (!userId || !activeSessions[userId]) return { ok: true };
  const rg = await getUserRG(userId);
  if (!rg.sessionMins) return { ok: true };
  const elapsed = Math.floor((Date.now() - activeSessions[userId].startTs) / 60000);
  if (elapsed >= rg.sessionMins) {
    return { ok: false, error: `Session limit reached (${rg.sessionMins} minutes). Take a break!`, elapsed };
  }
  return { ok: true, elapsed, limit: rg.sessionMins };
}

// ── Set limits ─────────────────────────────────────────────────────────────
// Limits can only be DECREASED immediately.
// Increases take 24h to take effect (legal requirement).
async function setLimits(userId, newLimits) {
  const rg  = await getUserRG(userId);
  const now = Date.now();
  const changes = [];

  const limitFields = ['depositDaily','depositWeekly','depositMonthly','lossDaily','sessionMins'];
  for (const field of limitFields) {
    if (newLimits[field] === undefined) continue;
    const parsed = newLimits[field] === null ? null : parseFloat(newLimits[field]);
    const newVal = (parsed === null || (Number.isFinite(parsed) && parsed > 0)) ? parsed : null;
    const oldVal = rg[field];
    if (oldVal === null || newVal === null || newVal <= oldVal) {
      rg[field] = newVal;
      changes.push({ field, value: newVal, effective: 'immediately' });
    } else {
      if (!rg.pendingLimits) rg.pendingLimits = {};
      rg.pendingLimits[field] = { value: newVal, applyAt: now + 86400000 };
      changes.push({ field, value: newVal, effective: '24 hours' });
    }
  }

  if (newLimits.realityCheckMins !== undefined) {
    rg.realityCheckMins = Math.max(15, parseInt(newLimits.realityCheckMins) || 60);
    changes.push({ field: 'realityCheckMins', value: rg.realityCheckMins, effective: 'immediately' });
  }

  await saveUserRG(userId, rg);
  return { ok: true, changes };
}

// ── Apply pending limit increases ─────────────────────────────────────────
async function applyPendingLimits(userId) {
  const rg  = await getUserRG(userId);
  if (!rg.pendingLimits) return rg;
  const now = Date.now();
  let changed = false;
  for (const [field, pending] of Object.entries(rg.pendingLimits)) {
    if (now >= pending.applyAt) {
      rg[field] = pending.value;
      delete rg.pendingLimits[field];
      changed = true;
    }
  }
  if (Object.keys(rg.pendingLimits).length === 0) delete rg.pendingLimits;
  if (changed) await saveUserRG(userId, rg);
  return rg;
}

// ── Self-exclusion ────────────────────────────────────────────────────────
async function selfExclude(userId, days) {
  const safeDays = (Number.isFinite(days) && days > 0) ? Math.floor(days) : null;
  const rg = await getUserRG(userId);
  rg.selfExcluded    = true;
  rg.selfExcludeUntil = safeDays ? Date.now() + (safeDays * 86400000) : null;
  await saveUserRG(userId, rg);
  return { ok: true, permanent: !safeDays, until: rg.selfExcludeUntil };
}

// ── Cooling-off period ────────────────────────────────────────────────────
async function setCooloff(userId, hours) {
  const safeHours = (Number.isFinite(hours) && hours > 0) ? Math.min(hours, 168) : 24;
  const rg = await getUserRG(userId);
  rg.cooloffUntil = Date.now() + (safeHours * 3600000);
  await saveUserRG(userId, rg);
  return { ok: true, until: rg.cooloffUntil };
}

// ── Get user's RG status ──────────────────────────────────────────────────
async function getRGStatus(userId) {
  const rg   = await applyPendingLimits(userId);
  const now  = Date.now();
  const day  = 86400000, week = 604800000, month = 2592000000;
  return {
    limits: {
      depositDaily:     rg.depositDaily,
      depositWeekly:    rg.depositWeekly,
      depositMonthly:   rg.depositMonthly,
      lossDaily:        rg.lossDaily,
      sessionMins:      rg.sessionMins,
      realityCheckMins: rg.realityCheckMins || 60,
    },
    usage: {
      depositedToday:   rg.deposits.filter(d=>now-d.ts<day  ).reduce((a,d)=>a+d.amount,0),
      depositedWeek:    rg.deposits.filter(d=>now-d.ts<week ).reduce((a,d)=>a+d.amount,0),
      depositedMonth:   rg.deposits.filter(d=>now-d.ts<month).reduce((a,d)=>a+d.amount,0),
      lostToday:        rg.losses.filter(l=>now-l.ts<day).reduce((a,l)=>a+l.amount,0),
      sessionMinsToday: rg.sessions.filter(s=>now-s.ts<day).reduce((a,s)=>a+s.durationMins,0),
    },
    status: {
      selfExcluded:     rg.selfExcluded,
      selfExcludeUntil: rg.selfExcludeUntil,
      cooloffUntil:     rg.cooloffUntil,
      pendingLimits:    rg.pendingLimits || null,
    },
  };
}

module.exports = {
  checkRGLimits, recordLoss, startSession, endSession,
  checkSessionLimit, checkSessionLimitAsync, setLimits, selfExclude, setCooloff,
  getRGStatus, getUserRG,
};
