// ══════════════════════════════════════════════════════════════════════════
// Anti-Cheat Engine v2 — Production Grade
// Detects: bot play, RTA solvers, chip dumping, collusion rings,
//          multi-accounting, ghosting, statistical anomalies
//
// Player-level accumulating state (sessions, flagged, collusionGraph,
// timing/chip-dump/stat history, suspicion score) is keyed by USERID — the
// authenticated account — so evidence survives across reconnects. Only
// per-connection state (rate-limit buckets, live-connection IP/fp sets used
// for concurrent multi-accounting) is keyed by socketId.
//
// Guests (socket.userId == null) never reach money/gold tables. They still
// hit ban checks in onConnect, but no session accumulation happens for them
// and every other entry point is a graceful no-op.
// ══════════════════════════════════════════════════════════════════════════
const EventEmitter = require('events');
const db = require('./db');

const SEV = { LOW:1, MEDIUM:2, HIGH:3, CRITICAL:4 };
const SEV_NAMES = {1:'LOW',2:'MEDIUM',3:'HIGH',4:'CRITICAL'};

// ── Ban persistence ────────────────────────────────────────────────────────
// Bans are stored in Postgres (ac_bans) — the previous JSON-file store lived
// on Railway's ephemeral /tmp and was wiped on every deploy, giving cheaters
// an easy reset. In-memory Sets stay as the hot lookup path; DB is the
// durable backing store with write-through on ban/unban and a loader on
// boot (see loadBansFromDB below).
async function _persistBan(type, value, reason) {
  if (!db.getPool()) return;
  try {
    await db.query(
      `INSERT INTO ac_bans (ban_type, value, reason) VALUES ($1,$2,$3)
       ON CONFLICT (ban_type, value) DO NOTHING`, [type, value, reason]);
  } catch (e) { console.error('[AntiCheat] persistBan failed:', e.message); }
}
async function _removeBan(type, value) {
  if (!db.getPool()) return;
  try {
    await db.query(`DELETE FROM ac_bans WHERE ban_type=$1 AND value=$2`, [type, value]);
  } catch (e) { console.error('[AntiCheat] removeBan failed:', e.message); }
}

// ── Storage ────────────────────────────────────────────────────────────────
// Accumulating (userId-keyed). MUST survive reconnect.
const sessions       = {};   // userId → SessionData
const flagged        = {};   // userId → Alert[]
const collusionGraph = {};   // userId → { wins:{loserUserId:amount}, losses:{winnerUserId:amount} }
const graphNames     = {};   // userId → latest display name (for dashboard readout only)

// Ephemeral (socketId-keyed). About "this connection right now," not history.
// Rate-limiting is inherently per-connection; ipMap/fpMap are the *live*
// connection sets we use to detect concurrent multi-accounting at connect
// time and at the seat level. Do NOT re-key these on userId — a single user
// with two tabs would then look like a single account to itself, defeating
// the point of the concurrent check for the multi-tab case (and it would
// also merge disconnected historical entries with live ones).
const actionBuckets  = {};   // socketId → timestamps[]
const ipMap          = {};   // ip → Set<socketId>
const fpMap          = {};   // fingerprint → Set<socketId>

// Bridges between the two keyspaces. Updated on connect, cleared on
// disconnect. Some call sites (velocity, IP-collision from seat lists) only
// have socketId in hand and need to resolve to userId for alerting.
const socketToUser   = {};   // socketId → userId
const userSockets    = {};   // userId → Set<socketId>

// Per-table ring of recent completed hands, for the multi-hand pairing
// analysis in the collusion detectors added in #4c/#4d. Populated by
// onHandComplete, cleared per-table by onTableRemoved (fallback cap at
// MAX_TABLES to bound growth if a teardown ever leaks).
const recentHands  = {};     // tableId → [slimHand, ...]
const HANDS_RING   = 60;     // hands retained per table
const MAX_TABLES   = 500;    // safety cap on distinct tables in the ring

// Sets start empty; loadBansFromDB fills them at boot.
const bannedIPs   = new Set();
const bannedNames = new Set();
const bannedFPs   = new Set();

// ── Session defaults ───────────────────────────────────────────────────────
// Only creates a session for an authenticated userId. Guests get null and
// every caller is expected to no-op on null.
function getSession(userId) {
  if (userId == null) return null;
  if (!sessions[userId]) sessions[userId] = {
    userId, name:null, ip:null, fingerprint:null,
    connectedAt: Date.now(),
    actionTimes: [],        // raw ms between actions
    actionCounts: {fold:0,call:0,check:0,raise:0},
    totalActions: 0,
    currentTable: null,
    tableHistory: new Set(),
    handResults: [],        // {toUserId, toName, amount, ts}
    suspicionScore: 0,
    currentStack: 0,
    handsPlayed: 0,
    totalWon: 0, totalLost: 0,
    lastActionTs: null,
    chatLog: [],
    // VPIP/PFR/AF tracking per-hand
    preflopVPIP: 0, preflopTotal: 0,
    preflopRaise: 0, totalHands: 0,
    aggrBets: 0, aggrCalls: 0,
    // Showdown stats
    showdownWins: 0, showdownTotal: 0,
    // Timing consistency
    lastTimings: [],
  };
  return sessions[userId];
}

function _liveSocketsFor(userId) {
  return userSockets[userId] ? [...userSockets[userId]] : [];
}

// ── Alert system ───────────────────────────────────────────────────────────
// All alerts are userId-keyed. Emitted alerts carry the live socket list so
// the server can target the player even if the connection has churned since
// evidence was first recorded.
function alert(userId, type, severity, detail, data={}) {
  if (userId == null) return null;
  if (!flagged[userId]) flagged[userId] = [];
  const sess = sessions[userId];
  const socketIds = _liveSocketsFor(userId);
  const a = {
    id: `${String(userId).slice(-6)}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    userId, socketIds,
    playerName: sess?.name || '?',
    type, severity, severityName: SEV_NAMES[severity],
    detail, data, ts: Date.now(), reviewed:false, action:null,
  };
  flagged[userId].push(a);
  if (flagged[userId].length > 100) flagged[userId].shift();
  if (sess) sess.suspicionScore += severity * 10;

  // Write-behind to DB. Alerts are high-volume and non-critical-path — never
  // await, never let a DB failure escape into detection code.
  if (db.getPool()) {
    db.query(
      `INSERT INTO ac_alerts (id,user_id,player_name,type,severity,severity_name,detail,data,reviewed,ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [a.id, userId != null ? String(userId) : null, a.playerName, a.type, a.severity,
       a.severityName, a.detail, JSON.stringify(a.data||{}), false, a.ts]
    ).catch(e => console.error('[AntiCheat] alert insert failed:', e.message));
  }

  antiCheat.emit('alert', a);
  return a;
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 1: Bot / RTA Timing Analysis
// ══════════════════════════════════════════════════════════════════════════
const BOT_FAST_THRESH   = 350;
const BOT_SIGMA_THRESH  = 45;
const BOT_SAMPLE_MIN    = 20;
const RTA_REPEAT_THRESH = 14;

function _checkTiming(userId, elapsed) {
  const sess = getSession(userId);
  if (!sess) return;
  sess.actionTimes.push(elapsed);
  if (sess.actionTimes.length > 60) sess.actionTimes.shift();
  sess.lastTimings.push(elapsed);
  if (sess.lastTimings.length > 30) sess.lastTimings.shift();

  const n = sess.actionTimes.length;
  if (n < BOT_SAMPLE_MIN) return;

  const recent20 = sess.actionTimes.slice(-20);

  const fastCount = recent20.filter(t => t < BOT_FAST_THRESH).length;
  if (fastCount >= 16) {
    alert(userId, 'BOT_FAST_TIMING', SEV.HIGH,
      `${fastCount}/20 actions under ${BOT_FAST_THRESH}ms — inhuman speed`,
      { fastCount, times: recent20 });
  }

  const mean  = recent20.reduce((a,b)=>a+b,0) / 20;
  const sigma = Math.sqrt(recent20.reduce((a,b)=>a+(b-mean)**2,0) / 20);
  if (sigma < BOT_SIGMA_THRESH && mean < 4000 && mean > 50) {
    alert(userId, 'BOT_CONSISTENT_TIMING', SEV.HIGH,
      `σ=${sigma.toFixed(0)}ms over 20 actions (mean=${mean.toFixed(0)}ms) — robotic consistency`,
      { sigma, mean });
  }

  if (n >= RTA_REPEAT_THRESH) {
    const lastN = sess.actionTimes.slice(-RTA_REPEAT_THRESH);
    const ref = lastN[0];
    const matches = lastN.filter(t => Math.abs(t-ref) < 25).length;
    if (matches >= RTA_REPEAT_THRESH - 1) {
      alert(userId, 'RTA_TIMING_PATTERN', SEV.MEDIUM,
        `${matches}/${RTA_REPEAT_THRESH} actions within 25ms of ${ref}ms — possible solver`,
        { ref, matches });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 2: GTO / Solver Statistical Analysis
// ══════════════════════════════════════════════════════════════════════════
function analyzePlayerStats(userId) {
  const sess = getSession(userId);
  if (!sess) return;
  if (sess.totalHands < 80) return;

  const vpip = sess.preflopVPIP  / Math.max(sess.preflopTotal, 1);
  const pfr  = sess.preflopRaise / Math.max(sess.preflopTotal, 1);
  const af   = sess.aggrBets     / Math.max(sess.aggrCalls, 1);
  const sdWR = sess.showdownWins / Math.max(sess.showdownTotal, 1);

  const vpipDev = Math.abs(vpip - 0.25);
  const pfrDev  = Math.abs(pfr - 0.20);

  if (vpipDev < 0.02 && pfrDev < 0.02 && sess.totalHands > 200) {
    alert(userId, 'SOLVER_EXACT_RANGES', SEV.HIGH,
      `VPIP=${(vpip*100).toFixed(1)}% PFR=${(pfr*100).toFixed(1)}% — suspiciously close to GTO`,
      { vpip, pfr, af, hands: sess.totalHands });
  }
  if (af > 8 && sess.aggrCalls > 30) {
    alert(userId, 'SOLVER_AF', SEV.MEDIUM,
      `AF=${af.toFixed(1)} over ${sess.totalHands} hands — solver-level aggression`,
      { af, bets: sess.aggrBets, calls: sess.aggrCalls });
  }
  if (sdWR > 0.72 && sess.showdownTotal > 50) {
    alert(userId, 'SUPERHUMAN_SD_WINRATE', SEV.MEDIUM,
      `Showdown WR=${(sdWR*100).toFixed(1)}% over ${sess.showdownTotal} showdowns`,
      { sdWR, showdownWins: sess.showdownWins, total: sess.showdownTotal });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 3: Collusion Graph Analysis
// Keyed by userId — closes the rename-evasion hole. Display names are kept
// separately in graphNames purely for dashboard readout.
// ══════════════════════════════════════════════════════════════════════════
function updateCollusionGraph(winnerUserId, loserUserId, winnerName, loserName, amount) {
  if (winnerUserId == null || loserUserId == null) return;
  if (winnerName) graphNames[winnerUserId] = winnerName;
  if (loserName)  graphNames[loserUserId]  = loserName;
  if (!collusionGraph[winnerUserId]) collusionGraph[winnerUserId] = { wins:{}, losses:{} };
  if (!collusionGraph[loserUserId])  collusionGraph[loserUserId]  = { wins:{}, losses:{} };
  collusionGraph[winnerUserId].wins[loserUserId]   = (collusionGraph[winnerUserId].wins[loserUserId]  ||0) + amount;
  collusionGraph[loserUserId].losses[winnerUserId] = (collusionGraph[loserUserId].losses[winnerUserId]||0) + amount;
}

function analyzeCollusionGraph(userId) {
  const node = collusionGraph[userId];
  if (!node) return;
  const winnerName = graphNames[userId] || sessions[userId]?.name || '?';

  // One player sending most of their losses to a single opponent
  for (const [loserUid, amt] of Object.entries(node.wins)) {
    const loserNode = collusionGraph[loserUid];
    if (!loserNode) continue;
    const loserTotalLoss = Object.values(loserNode.losses).reduce((a,b)=>a+b,0);
    const pctToWinner    = amt / Math.max(loserTotalLoss, 1);
    if (pctToWinner > 0.60 && amt > 100) {
      const loserName = graphNames[loserUid] || sessions[loserUid]?.name || '?';
      // Alert both parties (winner + loser). Skip loser alert if loser has
      // no live session record yet (they'll get one on next reconnect).
      alert(userId, 'COLLUSION_GRAPH', SEV.HIGH,
        `${loserName} sent ${(pctToWinner*100).toFixed(0)}% of losses ($${amt.toFixed(0)}) to ${winnerName}`,
        { winner:winnerName, winnerUserId:userId, loser:loserName, loserUserId:loserUid, amount:amt, pctToWinner });
      alert(loserUid, 'COLLUSION_GRAPH', SEV.HIGH,
        `${loserName} sent ${(pctToWinner*100).toFixed(0)}% of losses ($${amt.toFixed(0)}) to ${winnerName}`,
        { winner:winnerName, winnerUserId:userId, loser:loserName, loserUserId:loserUid, amount:amt, pctToWinner });
    }
  }

  // Detect 3-way circular chip flow: userId → b → c → userId
  for (const [b, abAmt] of Object.entries(node.wins)) {
    const bNode = collusionGraph[b];
    if (!bNode) continue;
    for (const [c, bcAmt] of Object.entries(bNode.wins)) {
      const cNode = collusionGraph[c];
      if (!cNode) continue;
      const caAmt = cNode.wins[userId] || 0;
      if (abAmt > 50 && bcAmt > 50 && caAmt > 50) {
        const bName = graphNames[b] || sessions[b]?.name || '?';
        const cName = graphNames[c] || sessions[c]?.name || '?';
        alert(userId, 'COLLUSION_RING', SEV.CRITICAL,
          `Circular chip flow: ${winnerName}→${bName}→${cName}→${winnerName} ($${abAmt.toFixed(0)}/$${bcAmt.toFixed(0)}/$${caAmt.toFixed(0)})`,
          { ring:[userId,b,c], names:[winnerName,bName,cName], amounts:[abAmt,bcAmt,caAmt] });
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 4: Device Fingerprint Multi-Accounting
// ══════════════════════════════════════════════════════════════════════════
function checkFingerprint(socketId, userId, fingerprint) {
  if (!fingerprint) return;
  const sess = getSession(userId);
  if (sess) sess.fingerprint = fingerprint;

  if (bannedFPs.has(fingerprint)) {
    if (userId != null) alert(userId, 'BANNED_DEVICE', SEV.CRITICAL,
      `Device fingerprint ${fingerprint.slice(0,16)}... is banned`, { fingerprint });
    return;
  }

  if (!fpMap[fingerprint]) fpMap[fingerprint] = new Set();
  fpMap[fingerprint].add(socketId);

  // Count DISTINCT userIds sharing this device (excluding self).
  const otherUsers = [...fpMap[fingerprint]]
    .filter(sid => sid !== socketId)
    .map(sid => socketToUser[sid])
    .filter(uid => uid != null && uid !== userId);
  const uniqueOtherUsers = [...new Set(otherUsers)];
  if (uniqueOtherUsers.length >= 1 && userId != null) {
    const names = uniqueOtherUsers.map(uid => sessions[uid]?.name).filter(Boolean);
    alert(userId, 'DEVICE_MULTI_ACCOUNT', SEV.CRITICAL,
      `Same device fingerprint: ${[sessions[userId]?.name, ...names].filter(Boolean).join(', ')}`,
      { fingerprint: fingerprint.slice(0,20), accounts: uniqueOtherUsers.length+1, names, userIds: uniqueOtherUsers });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 5: Velocity & Rate Limiting (per-connection)
// ══════════════════════════════════════════════════════════════════════════
function checkVelocity(socketId, userId) {
  const now = Date.now();
  if (!actionBuckets[socketId]) actionBuckets[socketId] = [];
  actionBuckets[socketId] = actionBuckets[socketId].filter(t => now - t < 10000);
  actionBuckets[socketId].push(now);
  const rate = actionBuckets[socketId].length;
  if (rate > 25) {
    if (userId != null) alert(userId, 'ACTION_VELOCITY', SEV.HIGH,
      `${rate} actions in 10 seconds — scripted automation suspected`,
      { rate, window: '10s' });
    return false; // block action either way
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 6: Chip Dump
// ══════════════════════════════════════════════════════════════════════════
const DUMP_THRESHOLD = 3;
const DUMP_MIN_POT   = 15;
const DUMP_STACK_PCT = 0.70;

function checkChipDump(loserUserId, winnerUserId, winnerName, amount, loserStack) {
  const sess = getSession(loserUserId);
  if (!sess) return;
  const now  = Date.now();
  sess.handResults.push({ toUserId: winnerUserId, toName: winnerName, amount, ts: now });
  sess.handResults = sess.handResults.filter(r => now - r.ts < 86400000);

  const hourCutoff = now - 3600000;
  const recentToSame = sess.handResults.filter(r =>
    r.toUserId != null && r.toUserId === winnerUserId &&
    r.ts > hourCutoff && r.amount >= DUMP_MIN_POT);
  const hourTotal = recentToSame.reduce((a,r) => a+r.amount, 0);

  if (recentToSame.length >= DUMP_THRESHOLD) {
    alert(loserUserId, 'CHIP_DUMP_PATTERN', SEV.HIGH,
      `Lost to ${winnerName} ${recentToSame.length}× in 1hr ($${hourTotal.toFixed(0)} total)`,
      { winner: winnerName, winnerUserId, count: recentToSame.length, total: hourTotal });
  }
  if (loserStack > 0 && amount / loserStack >= DUMP_STACK_PCT && amount >= DUMP_MIN_POT) {
    alert(loserUserId, 'CHIP_DUMP_LARGE', SEV.MEDIUM,
      `Lost ${Math.round(amount/loserStack*100)}% of stack ($${amount}) in one hand`,
      { amount, stack: loserStack, ratio: (amount/loserStack).toFixed(2) });
  }
  updateCollusionGraph(winnerUserId, loserUserId, winnerName, sess.name, amount);
  analyzeCollusionGraph(loserUserId);
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 7: Ghosting / Remote Coaching
// ══════════════════════════════════════════════════════════════════════════
function checkGhosting(userId, elapsed, potSize, stackSize) {
  const bigPot = potSize / Math.max(stackSize, 1) > 0.35;
  if (elapsed > 20000 && bigPot) {
    alert(userId, 'GHOSTING_RISK', SEV.LOW,
      `${(elapsed/1000).toFixed(0)}s pause on ${Math.round(potSize/stackSize*100)}% pot decision`,
      { elapsed, potSize, stackSize });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 8: IP / Same-table multi-accounting
// Detection operates on live seat connections (socketId), but before we
// count we resolve each seat → userId and dedupe. A single user with two
// browser tabs at the same table = two sockets, one userId, and MUST NOT be
// flagged as sharing an IP with itself.
// ══════════════════════════════════════════════════════════════════════════
function checkIPCollision(tableId, seats) {
  const ipGroups = {}; // ip → Map<userId, { userId, name }>
  for (const seat of seats) {
    const userId = socketToUser[seat.socketId];
    if (userId == null) continue; // guest — no session to check IP against
    const ip = sessions[userId]?.ip;
    if (!ip) continue;
    if (!ipGroups[ip]) ipGroups[ip] = new Map();
    if (!ipGroups[ip].has(userId)) {
      ipGroups[ip].set(userId, { userId, name: seat.name || sessions[userId]?.name });
    }
  }
  for (const [ip, byUser] of Object.entries(ipGroups)) {
    if (byUser.size >= 2) {
      const users = [...byUser.values()];
      users.forEach(u =>
        alert(u.userId, 'SAME_IP_SAME_TABLE', SEV.HIGH,
          `${users.length} players at ${tableId} share IP ${ip}: ${users.map(x=>x.name).join(', ')}`,
          { ip, players: users.map(x=>x.name), userIds: users.map(x=>x.userId), tableId })
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 9: Suspicious chat patterns
// ══════════════════════════════════════════════════════════════════════════
const CHAT_COLLUSION = [
  /i\s*(have|got|hold)\s+(aces?|kings?|queens?|pair|flush|straight|full house|two pair)/i,
  /(fold|check|raise|bet|call)\s+(it|now|please|to\s+me|for\s+me)/i,
  /(dump|transfer|give\s+me|send\s+me)\s+chips?/i,
  /sign(al)?\s+when|code\s+word/i,
  /what\s+(do\s+you\s+have|are\s+your\s+cards)/i,
];

function checkChat(userId, message) {
  const sess = getSession(userId);
  if (!sess) return;
  const now  = Date.now();
  sess.chatLog.push({ ts: now, msg: message });
  if (sess.chatLog.length > 200) sess.chatLog.shift();

  for (const pattern of CHAT_COLLUSION) {
    if (pattern.test(message)) {
      alert(userId, 'CHAT_COLLUSION', SEV.MEDIUM,
        `Suspicious message: "${message.slice(0,80)}"`,
        { message, pattern: pattern.source });
      break;
    }
  }
  const flood = sess.chatLog.filter(c => now - c.ts < 5000).length;
  if (flood > 10) {
    alert(userId, 'CHAT_FLOOD', SEV.LOW, `${flood} messages in 5 seconds`, { count: flood });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 10: Username similarity (banned-name evasion)
// ══════════════════════════════════════════════════════════════════════════
function checkUsernameSimilarity(name) {
  const newNorm = name.toLowerCase().replace(/[^a-z]/g,'');
  for (const bannedN of bannedNames) {
    const bannedNorm = bannedN.replace(/[^a-z]/g,'');
    if (levenshtein(newNorm, bannedNorm) <= 2 && bannedNorm.length > 3) {
      return { similar: true, to: bannedN };
    }
  }
  return { similar: false };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i||j));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════
const antiCheat = new EventEmitter();

// onConnect(socketId, userId, playerName, ip, fingerprint)
// - Runs ban checks for everyone (guests included).
// - For guests: no session created, no accumulation. Socket is still added
//   to ipMap so that when an authed user later joins from the same IP we
//   detect it via the multi-account IP check.
// - For authed users: bridges socket→user maps, loads/creates the userId
//   session, runs multi-account + fingerprint + similarity checks.
antiCheat.onConnect = (socketId, userId, playerName, ip, fingerprint) => {
  // Ban checks apply to everyone.
  if (ip && bannedIPs.has(ip)) {
    if (userId != null) alert(userId, 'BAN_EVASION_IP', SEV.CRITICAL, `Banned IP: ${ip}`, { ip });
    return { blocked:true, reason:'IP address is banned' };
  }
  if (playerName && bannedNames.has(playerName.toLowerCase())) {
    if (userId != null) alert(userId, 'BAN_EVASION_NAME', SEV.CRITICAL, `Banned name: ${playerName}`, { playerName });
    return { blocked:true, reason:'Username is banned' };
  }
  if (fingerprint && bannedFPs.has(fingerprint)) {
    if (userId != null) alert(userId, 'BANNED_DEVICE', SEV.CRITICAL, `Banned device`, { fingerprint });
    return { blocked:true, reason:'Device is banned' };
  }

  if (userId == null) {
    // Guest: keep the connection tracked in ipMap for concurrent-IP
    // detection, but do NOT create a session or accumulate anything.
    if (ip) {
      if (!ipMap[ip]) ipMap[ip] = new Set();
      ipMap[ip].add(socketId);
    }
    return { blocked:false };
  }

  // Authed user: bridge socket → user.
  socketToUser[socketId] = userId;
  if (!userSockets[userId]) userSockets[userId] = new Set();
  userSockets[userId].add(socketId);

  const sess = getSession(userId);
  sess.name = playerName || sess.name;
  sess.ip   = ip || sess.ip || 'unknown';

  if (playerName) {
    const sim = checkUsernameSimilarity(playerName);
    if (sim.similar) {
      alert(userId, 'USERNAME_EVASION', SEV.HIGH,
        `"${playerName}" is similar to banned "${sim.to}"`, { playerName, similar: sim.to });
    }
  }
  if (fingerprint) checkFingerprint(socketId, userId, fingerprint);

  // Multi-account by IP — dedupe by userId. Same user reconnecting is NOT a
  // second account.
  if (ip) {
    if (!ipMap[ip]) ipMap[ip] = new Set();
    ipMap[ip].add(socketId);
    const otherUsers = [...ipMap[ip]]
      .filter(sid => sid !== socketId)
      .map(sid => socketToUser[sid])
      .filter(uid => uid != null && uid !== userId);
    const uniqueOtherUsers = [...new Set(otherUsers)];
    if (uniqueOtherUsers.length >= 1) {
      const names = uniqueOtherUsers.map(uid => sessions[uid]?.name).filter(Boolean);
      alert(userId, 'MULTI_ACCOUNT_IP', SEV.HIGH,
        `IP ${ip} has ${uniqueOtherUsers.length+1} active accounts: ${[...names, playerName].filter(Boolean).join(', ')}`,
        { ip, accounts: uniqueOtherUsers.length+1, names: [...names, playerName].filter(Boolean), userIds: uniqueOtherUsers });
    }
  }
  return { blocked:false };
};

antiCheat.onFingerprint = (socketId, userId, fingerprint) => {
  checkFingerprint(socketId, userId, fingerprint);
};

antiCheat.onAction = (socketId, userId, action, tableId, ctx={}) => {
  // Velocity is per-connection so we always check it, even for guests.
  const ok = checkVelocity(socketId, userId);
  if (!ok) return false;

  const sess = getSession(userId);
  if (!sess) return true; // guest — no accumulation, but action is allowed

  const now  = Date.now();
  if (sess.lastActionTs) {
    const elapsed = now - sess.lastActionTs;
    _checkTiming(userId, elapsed);
    if (ctx.potSize) checkGhosting(userId, elapsed, ctx.potSize, ctx.stackSize||0);
  }
  sess.lastActionTs = now;
  sess.totalActions++;
  sess.actionCounts[action] = (sess.actionCounts[action]||0)+1;

  if (ctx.isPreflop && ctx.isFirstAction) {
    sess.preflopTotal++;
    if (action==='call'||action==='raise') sess.preflopVPIP++;
    if (action==='raise') sess.preflopRaise++;
  }
  if (action==='raise') sess.aggrBets++;
  if (action==='call')  sess.aggrCalls++;
  if (sess.totalActions>0 && sess.totalActions%25===0) analyzePlayerStats(userId);
  return true;
};

// handData expects winnerUserId + loserUserId (added by server.js — resolved
// via io.sockets.sockets.get(sid)?.userId at hand-result time). winner/loser
// name strings are still used for alert readability.
antiCheat.onHandResult = (tableId, handData) => {
  const { winner, loser, winnerSocket, loserSocket, winnerUserId, loserUserId, amount, isShowdown } = handData;
  const loserSess = loserUserId != null ? sessions[loserUserId] : null;
  if (loserSess && amount > 0) {
    loserSess.totalLost += amount;
    checkChipDump(loserUserId, winnerUserId, winner, amount, loserSess.currentStack);
  }
  const winnerSess = winnerUserId != null ? sessions[winnerUserId] : null;
  if (winnerSess) {
    winnerSess.totalWon += amount;
    winnerSess.handsPlayed++;
    if (isShowdown) { winnerSess.showdownWins++; winnerSess.showdownTotal++; }
  }
  if (loserSess && isShowdown) loserSess.showdownTotal++;
};

antiCheat.onJoinTable = (socketId, userId, tableId, seats) => {
  const sess = getSession(userId);
  if (sess) {
    sess.tableHistory.add(tableId);
    sess.currentTable = tableId;
  }
  // seats carry socketId (live connections). checkIPCollision resolves each
  // seat → userId internally.
  if (seats?.length) checkIPCollision(tableId, seats);
};

antiCheat.onLeaveTable = (socketId, userId) => {
  const sess = userId != null ? sessions[userId] : null;
  if (sess) sess.currentTable = null;
};

antiCheat.onChat = (socketId, userId, msg) => {
  if (userId == null) return;
  checkChat(userId, msg);
};

antiCheat.onDisconnect = (socketId, userId) => {
  // Prefer the userId arg; fall back to the map in case the caller lost track.
  const uid = userId != null ? userId : socketToUser[socketId];

  // Per-connection ephemeral cleanup — walk maps by socketId so guests
  // (which never registered a userId session) are still cleaned up.
  for (const ip of Object.keys(ipMap)) {
    if (ipMap[ip].has(socketId)) {
      ipMap[ip].delete(socketId);
      if (!ipMap[ip].size) delete ipMap[ip];
    }
  }
  for (const fp of Object.keys(fpMap)) {
    if (fpMap[fp].has(socketId)) {
      fpMap[fp].delete(socketId);
      if (!fpMap[fp].size) delete fpMap[fp];
    }
  }
  delete actionBuckets[socketId];

  // socket→user bridge cleanup.
  if (uid != null && userSockets[uid]) {
    userSockets[uid].delete(socketId);
    if (!userSockets[uid].size) delete userSockets[uid];
  }
  delete socketToUser[socketId];

  // DO NOT delete sessions[uid] or flagged[uid]. Accumulated evidence must
  // survive the connection dropping. It will still be lost on process
  // restart until refactor #2 adds DB persistence — that's expected.
};

antiCheat.setPlayerStack = (socketId, userId, stack) => {
  const sess = userId != null ? sessions[userId] : null;
  if (sess) sess.currentStack = stack;
};

// Admin controls — write-through to Postgres. All async now; every caller
// must await.
antiCheat.banIP = async (ip, reason='') => {
  bannedIPs.add(ip);
  await _persistBan('ip', ip, reason);
};
antiCheat.banName = async (name, reason='') => {
  const n = name.toLowerCase();
  bannedNames.add(n);
  await _persistBan('name', n, reason);
};
antiCheat.banFP = async (fp, reason='') => {
  bannedFPs.add(fp);
  await _persistBan('fp', fp, reason);
};
antiCheat.unbanIP = async (ip) => {
  bannedIPs.delete(ip);
  await _removeBan('ip', ip);
};
antiCheat.unbanName = async (name) => {
  const n = name.toLowerCase();
  bannedNames.delete(n);
  await _removeBan('name', n);
};
antiCheat.unbanFP = async (fp) => {
  bannedFPs.delete(fp);
  await _removeBan('fp', fp);
};

// Boot loader — populate Sets from ac_bans. Called from server.js after
// initAuth/initDB. Silent no-op if DB is not configured.
antiCheat.loadBansFromDB = async () => {
  if (!db.getPool()) return;
  try {
    const rows = await db.query(`SELECT ban_type, value FROM ac_bans`);
    for (const r of rows) {
      if (r.ban_type === 'ip')   bannedIPs.add(r.value);
      if (r.ban_type === 'name') bannedNames.add(r.value);
      if (r.ban_type === 'fp')   bannedFPs.add(r.value);
    }
    console.log(`[AntiCheat] Loaded ${rows.length} bans from DB.`);
  } catch (e) { console.error('[AntiCheat] loadBans failed:', e.message); }
};

// Boot loader — repopulate `flagged` with recent unreviewed alerts so the
// admin console isn't blank after a restart. Bounded to 7 days / 5000 rows.
antiCheat.loadAlertsFromDB = async () => {
  if (!db.getPool()) return;
  try {
    const rows = await db.query(
      `SELECT * FROM ac_alerts WHERE reviewed=false AND ts > $1 ORDER BY ts DESC LIMIT 5000`,
      [Date.now() - 7*24*3600*1000]);
    for (const r of rows) {
      const uid = r.user_id;
      const a = {
        id: r.id, socketIds: [], userId: uid, playerName: r.player_name,
        type: r.type, severity: r.severity, severityName: r.severity_name,
        detail: r.detail, data: r.data || {}, ts: Number(r.ts),
        reviewed: r.reviewed, action: r.action, adminNote: r.admin_note,
      };
      if (!flagged[uid]) flagged[uid] = [];
      flagged[uid].push(a);
    }
    // Match runtime ordering (oldest→newest) and re-apply the 100-cap.
    for (const uid of Object.keys(flagged)) {
      flagged[uid].sort((x,y)=>x.ts-y.ts);
      if (flagged[uid].length > 100) flagged[uid] = flagged[uid].slice(-100);
    }
    console.log(`[AntiCheat] Loaded ${rows.length} unreviewed alerts from DB.`);
  } catch (e) { console.error('[AntiCheat] loadAlerts failed:', e.message); }
};

antiCheat.getAlerts = ({minSeverity=1, unreviewed=false, userId=null, type=null}={}) => {
  let all = Object.values(flagged).flat();
  if (userId != null) all = all.filter(a => String(a.userId) === String(userId));
  if (type)     all = all.filter(a=>a.type===type);
  if (unreviewed) all = all.filter(a=>!a.reviewed);
  return all.filter(a=>a.severity>=minSeverity).sort((a,b)=>b.ts-a.ts);
};

antiCheat.reviewAlert = (alertId, action, note='') => {
  for (const arr of Object.values(flagged)) {
    const a = arr.find(x=>x.id===alertId);
    if (a) {
      a.reviewed = true; a.action = action; a.adminNote = note;
      // Write-through — durably mark reviewed. Fire-and-forget: the admin
      // UI already has the response; a failed persist is a log line, not an
      // error to the reviewer.
      if (db.getPool()) {
        db.query(
          `UPDATE ac_alerts SET reviewed=true, action=$1, admin_note=$2 WHERE id=$3`,
          [action, note, alertId]
        ).catch(e => console.error('[AntiCheat] reviewAlert persist failed:', e.message));
      }
      return a;
    }
  }
  return null;
};

antiCheat.getPlayerReport = userId => {
  const sess = sessions[userId]||{};
  const alerts = flagged[userId]||[];
  const vpip = sess.preflopVPIP/Math.max(sess.preflopTotal,1);
  const pfr  = sess.preflopRaise/Math.max(sess.preflopTotal,1);
  const af   = sess.aggrBets/Math.max(sess.aggrCalls,1);
  return {
    ...sess, alerts,
    tableHistory:[...sess.tableHistory||[]],
    liveSockets: _liveSocketsFor(userId),
    stats:{ vpip:(vpip*100).toFixed(1), pfr:(pfr*100).toFixed(1), af:af.toFixed(2),
      sdWR:sess.showdownTotal>0?((sess.showdownWins/sess.showdownTotal)*100).toFixed(1):'N/A',
      handsPlayed:sess.handsPlayed||0, totalWon:sess.totalWon||0, totalLost:sess.totalLost||0 },
    criticalCount: alerts.filter(a=>a.severity===4).length,
    highCount:     alerts.filter(a=>a.severity===3).length,
    medCount:      alerts.filter(a=>a.severity===2).length,
    lowCount:      alerts.filter(a=>a.severity===1).length,
  };
};

antiCheat.getDashboard = () => {
  const allAlerts = Object.values(flagged).flat();
  return {
    totalPlayers:    Object.keys(sessions).length,
    flaggedPlayers:  Object.keys(flagged).filter(id=>flagged[id]?.length>0).length,
    criticalAlerts:  allAlerts.filter(a=>a.severity===4&&!a.reviewed).length,
    highAlerts:      allAlerts.filter(a=>a.severity===3&&!a.reviewed).length,
    recentAlerts:    antiCheat.getAlerts({minSeverity:1}).slice(0,30),
    bannedIPs:       [...bannedIPs],
    bannedNames:     [...bannedNames],
    suspicionLeaderboard: Object.values(sessions)
      .sort((a,b)=>b.suspicionScore-a.suspicionScore).slice(0,15)
      .map(s=>({ userId:s.userId, name:s.name, score:s.suspicionScore,
                 alerts:(flagged[s.userId]||[]).length, ip:s.ip })),
    collusionGraph: Object.entries(collusionGraph).slice(0,20).map(([uid,data])=>{
      const top = Object.entries(data.wins).sort((a,b)=>b[1]-a[1])[0];
      if (!top) return null;
      return { userId: uid,
               name:   graphNames[uid] || sessions[uid]?.name || '?',
               topWin: [graphNames[top[0]] || sessions[top[0]]?.name || '?', top[1]] };
    }).filter(Boolean),
  };
};

// Returns live socketIds currently matching a ban value, for immediate
// ejection when an admin bans someone who is already connected/seated.
// Reads only from the live-connection maps and socket→user bridge — this is
// a look-up, not a heuristic, so it's safe to hand straight to a kick path.
antiCheat.socketsMatchingBan = (type, value) => {
  const out = new Set();
  if (type === 'ip') {
    for (const [sid, uid] of Object.entries(socketToUser)) {
      if (sessions[uid]?.ip === value) out.add(sid);
    }
    if (ipMap[value]) for (const sid of ipMap[value]) out.add(sid);
  } else if (type === 'name') {
    const lc = String(value).toLowerCase();
    for (const [uid, s] of Object.entries(sessions)) {
      if ((s.name||'').toLowerCase() === lc) {
        for (const sid of (userSockets[uid]||[])) out.add(sid);
      }
    }
  } else if (type === 'fp') {
    if (fpMap[value]) for (const sid of fpMap[value]) out.add(sid);
  }
  return [...out];
};

// Best-effort display-name → userId map for players in a table's most
// recent hand. antiCheat doesn't import tableManager, so this reverse-maps
// through the global sessions store (which is keyed by userId and carries
// the latest known display name). Limitations: two users with the same
// display name would collide, and a user who has fully left the session
// pool won't resolve. Detectors in #4c/#4d that need table-accurate
// resolution should have the server pass the actual seat list.
function _resolveTableNames(_tableId) {
  const map = {};
  for (const [uid, s] of Object.entries(sessions)) {
    if (s?.name) map[s.name] = uid;
  }
  return map;
}

// Called once per completed hand with the FULL hand record from
// handHistory, including record.actions[] = [{ts, player, action, amount,
// pot, phase}, ...]. #4c/#4d detectors will read from the recentHands
// ring; here we just accumulate the minimum needed. No detection yet.
antiCheat.onHandComplete = (tableId, record) => {
  if (!record || !Array.isArray(record.actions)) return;

  const nameToUser = _resolveTableNames(tableId);

  // Store only what a pairing analyzer needs, not the whole record.
  const slim = {
    handId:  record.handId,
    ts:      record.endTs || Date.now(),
    winner:  record.winner,
    amount:  record.amount || 0,
    reason:  record.reason,
    showdown: (record.reason === 'showdown'),
    actions: record.actions.map(a => ({
      user:   nameToUser[a.player] || null,
      name:   a.player,
      action: a.action,
      amount: a.amount || 0,
      phase:  a.phase,
    })),
    seats: Object.values(nameToUser),
  };

  if (!recentHands[tableId]) recentHands[tableId] = [];
  recentHands[tableId].push(slim);
  if (recentHands[tableId].length > HANDS_RING) recentHands[tableId].shift();

  // Fallback bound if a teardown ever leaks: drop the oldest table entry.
  const keys = Object.keys(recentHands);
  if (keys.length > MAX_TABLES) delete recentHands[keys[0]];

  // #4c/#4d detectors will be invoked from here. No-op for now.
};

// Called from server.js at every tableManager.removeTable(tid) site.
antiCheat.onTableRemoved = (tableId) => {
  delete recentHands[tableId];
};

antiCheat.SEV = SEV;

module.exports = { antiCheat };
