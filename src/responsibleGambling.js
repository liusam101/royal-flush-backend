// ══════════════════════════════════════════════════════════════════════════
// Responsible Gambling — Royal Flush Poker
// Legally required features for real-money gaming:
//   - Deposit limits (daily, weekly, monthly)
//   - Session time limits
//   - Loss limits
//   - Self-exclusion (temporary or permanent)
//   - Reality checks (periodic reminders)
//   - Cooling-off periods
// ══════════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.RAILWAY_ENVIRONMENT
  ? require('path').join('/tmp', 'rfdata')
  : path.join(__dirname, '../../data');
const RG_FILE  = path.join(DATA_DIR, 'rg_limits.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}

// ── Storage ────────────────────────────────────────────────────────────────
function loadRG() {
  try { return JSON.parse(fs.readFileSync(RG_FILE, 'utf8')); } catch(_) { return {}; }
}
function saveRG(data) {
  try { fs.writeFileSync(RG_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('[RG] save failed:', e.message); }
}

// ── Default limits ─────────────────────────────────────────────────────────
const DEFAULT_LIMITS = {
  depositDaily:   null,   // $ per day (null = no limit)
  depositWeekly:  null,   // $ per week
  depositMonthly: null,   // $ per month
  lossDaily:      null,   // $ loss per day
  sessionMins:    null,   // max session minutes
  selfExcluded:   false,
  selfExcludeUntil: null, // timestamp
  cooloffUntil:   null,   // cooling-off period timestamp
  realityCheckMins: 60,   // reality check interval
};

function getUserRG(userId) {
  const data = loadRG();
  if (!data[userId]) data[userId] = { ...DEFAULT_LIMITS, userId, deposits: [], sessions: [], losses: [] };
  return data[userId];
}

function saveUserRG(userId, rg) {
  const data = loadRG();
  data[userId] = rg;
  saveRG(data);
}

// ── Check if user can play ─────────────────────────────────────────────────
async function checkRGLimits(userId, buyInAmount) {
  if (!userId) return { ok: true }; // guest — no limits
  const rg  = getUserRG(userId);
  const now = Date.now();

  // Self-exclusion
  if (rg.selfExcluded) {
    if (rg.selfExcludeUntil && now > rg.selfExcludeUntil) {
      // Exclusion expired — lift it
      rg.selfExcluded = false; rg.selfExcludeUntil = null;
      saveUserRG(userId, rg);
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
    // Keep last 1000 deposits
    if (rg.deposits.length > 1000) rg.deposits = rg.deposits.slice(-1000);
    saveUserRG(userId, rg);
  }

  return { ok: true };
}

// ── Record a loss ─────────────────────────────────────────────────────────
function recordLoss(userId, amount) {
  if (!userId || amount <= 0) return;
  const rg = getUserRG(userId);
  rg.losses.push({ ts: Date.now(), amount });
  if (rg.losses.length > 1000) rg.losses = rg.losses.slice(-1000);
  saveUserRG(userId, rg);
}

// ── Session tracking ───────────────────────────────────────────────────────
const activeSessions = {}; // userId → { startTs, tableId }

function startSession(userId, tableId) {
  if (!userId) return;
  activeSessions[userId] = { startTs: Date.now(), tableId };
}

function endSession(userId) {
  if (!userId || !activeSessions[userId]) return;
  const sess = activeSessions[userId];
  const dur  = Math.floor((Date.now() - sess.startTs) / 60000); // minutes
  const rg   = getUserRG(userId);
  rg.sessions.push({ ts: sess.startTs, durationMins: dur });
  if (rg.sessions.length > 500) rg.sessions = rg.sessions.slice(-500);
  saveUserRG(userId, rg);
  delete activeSessions[userId];
}

function checkSessionLimit(userId) {
  if (!userId || !activeSessions[userId]) return { ok: true };
  const rg   = getUserRG(userId);
  if (!rg.sessionMins) return { ok: true };
  const elapsed = Math.floor((Date.now() - activeSessions[userId].startTs) / 60000);
  if (elapsed >= rg.sessionMins) {
    return { ok: false, error: `Session limit reached (${rg.sessionMins} minutes). Take a break!`, elapsed };
  }
  return { ok: true, elapsed, limit: rg.sessionMins };
}

// ── Set limits ─────────────────────────────────────────────────────────────
// NOTE: Limits can only be DECREASED immediately.
// Increases take 24h to take effect (legal requirement).
function setLimits(userId, newLimits) {
  const rg  = getUserRG(userId);
  const now = Date.now();
  const changes = [];

  const limitFields = ['depositDaily','depositWeekly','depositMonthly','lossDaily','sessionMins'];
  for (const field of limitFields) {
    if (newLimits[field] === undefined) continue;
    const newVal = newLimits[field] === null ? null : parseFloat(newLimits[field]);
    const oldVal = rg[field];
    // Decreasing limit: apply immediately
    // Increasing limit: apply after 24h (store as pending)
    if (oldVal === null || newVal === null || newVal <= oldVal) {
      rg[field] = newVal;
      changes.push({ field, value: newVal, effective: 'immediately' });
    } else {
      // Queue pending increase
      if (!rg.pendingLimits) rg.pendingLimits = {};
      rg.pendingLimits[field] = { value: newVal, applyAt: now + 86400000 };
      changes.push({ field, value: newVal, effective: '24 hours' });
    }
  }

  if (newLimits.realityCheckMins !== undefined) {
    rg.realityCheckMins = Math.max(15, parseInt(newLimits.realityCheckMins) || 60);
    changes.push({ field: 'realityCheckMins', value: rg.realityCheckMins, effective: 'immediately' });
  }

  saveUserRG(userId, rg);
  return { ok: true, changes };
}

// ── Apply pending limit increases ─────────────────────────────────────────
function applyPendingLimits(userId) {
  const rg  = getUserRG(userId);
  if (!rg.pendingLimits) return;
  const now = Date.now();
  for (const [field, pending] of Object.entries(rg.pendingLimits)) {
    if (now >= pending.applyAt) {
      rg[field] = pending.value;
      delete rg.pendingLimits[field];
    }
  }
  if (Object.keys(rg.pendingLimits).length === 0) delete rg.pendingLimits;
  saveUserRG(userId, rg);
}

// ── Self-exclusion ────────────────────────────────────────────────────────
function selfExclude(userId, days) {
  // days = null for permanent, number for temporary
  const rg = getUserRG(userId);
  rg.selfExcluded   = true;
  rg.selfExcludeUntil = days ? Date.now() + (days * 86400000) : null;
  saveUserRG(userId, rg);
  return { ok: true, permanent: !days, until: rg.selfExcludeUntil };
}

// ── Cooling-off period ────────────────────────────────────────────────────
function setCooloff(userId, hours) {
  const rg = getUserRG(userId);
  rg.cooloffUntil = Date.now() + (hours * 3600000);
  saveUserRG(userId, rg);
  return { ok: true, until: rg.cooloffUntil };
}

// ── Get user's RG status ──────────────────────────────────────────────────
function getRGStatus(userId) {
  applyPendingLimits(userId);
  const rg   = getUserRG(userId);
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
  checkSessionLimit, setLimits, selfExclude, setCooloff,
  getRGStatus, getUserRG,
};
