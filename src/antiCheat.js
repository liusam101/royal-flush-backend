// ══════════════════════════════════════════════════════════════════════════
// Anti-Cheat Engine v2 — Production Grade
// Detects: bot play, RTA solvers, chip dumping, collusion rings,
//          multi-accounting, ghosting, statistical anomalies
// ══════════════════════════════════════════════════════════════════════════
const EventEmitter = require('events');

const SEV = { LOW:1, MEDIUM:2, HIGH:3, CRITICAL:4 };
const SEV_NAMES = {1:'LOW',2:'MEDIUM',3:'HIGH',4:'CRITICAL'};

// ── Storage ───────────────────────────────────────────────────────────────
const sessions    = {};  // socketId → SessionData
const ipMap       = {};  // ip → Set<socketId>
const fpMap       = {};  // fingerprint → Set<socketId>
const flagged     = {};  // socketId → Alert[]
const collusionGraph = {}; // playerId → { wins: {vs:amount}, losses: {vs:amount} }

const bannedIPs   = new Set();
const bannedNames = new Set();
const bannedFPs   = new Set();

// ── Session defaults ───────────────────────────────────────────────────────
function getSession(socketId) {
  if (!sessions[socketId]) sessions[socketId] = {
    socketId, name:null, ip:null, fingerprint:null,
    connectedAt: Date.now(),
    actionTimes: [],        // raw ms between actions
    actionCounts: {fold:0,call:0,check:0,raise:0},
    totalActions: 0,
    currentTable: null,
    tableHistory: new Set(),
    handResults: [],        // {winner,loser,amount,ts}
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
  return sessions[socketId];
}

// ── Alert system ───────────────────────────────────────────────────────────
function alert(socketId, type, severity, detail, data={}) {
  if (!flagged[socketId]) flagged[socketId] = [];
  const a = {
    id: `${socketId.slice(-6)}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    socketId, playerName: sessions[socketId]?.name || '?',
    type, severity, severityName: SEV_NAMES[severity],
    detail, data, ts: Date.now(), reviewed:false, action:null,
  };
  flagged[socketId].push(a);
  // Cap at 100 alerts per player
  if (flagged[socketId].length > 100) flagged[socketId].shift();
  sessions[socketId].suspicionScore += severity * 10;
  antiCheat.emit('alert', a);
  return a;
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 1: Bot / RTA Timing Analysis
// ══════════════════════════════════════════════════════════════════════════
const BOT_FAST_THRESH   = 350;  // ms — humans rarely act this fast consistently
const BOT_SIGMA_THRESH  = 45;   // ms std deviation — bots are too consistent
const BOT_SAMPLE_MIN    = 20;   // need 20 actions before flagging
const RTA_REPEAT_THRESH = 14;   // same delay ±25ms, 14 times = RTA

function _checkTiming(socketId, elapsed) {
  const sess = getSession(socketId);
  sess.actionTimes.push(elapsed);
  if (sess.actionTimes.length > 60) sess.actionTimes.shift();
  sess.lastTimings.push(elapsed);
  if (sess.lastTimings.length > 30) sess.lastTimings.shift();

  const n = sess.actionTimes.length;
  if (n < BOT_SAMPLE_MIN) return;

  const recent20 = sess.actionTimes.slice(-20);

  // 1a: Sustained fast play
  const fastCount = recent20.filter(t => t < BOT_FAST_THRESH).length;
  if (fastCount >= 16) {
    alert(socketId, 'BOT_FAST_TIMING', SEV.HIGH,
      `${fastCount}/20 actions under ${BOT_FAST_THRESH}ms — inhuman speed`,
      { fastCount, times: recent20 });
  }

  // 1b: Inhuman consistency (low std dev)
  const mean = recent20.reduce((a,b)=>a+b,0) / 20;
  const sigma = Math.sqrt(recent20.reduce((a,b)=>a+(b-mean)**2,0) / 20);
  if (sigma < BOT_SIGMA_THRESH && mean < 4000 && mean > 50) {
    alert(socketId, 'BOT_CONSISTENT_TIMING', SEV.HIGH,
      `σ=${sigma.toFixed(0)}ms over 20 actions (mean=${mean.toFixed(0)}ms) — robotic consistency`,
      { sigma, mean });
  }

  // 1c: RTA pattern — exact same delay repeatedly
  if (n >= RTA_REPEAT_THRESH) {
    const lastN = sess.actionTimes.slice(-RTA_REPEAT_THRESH);
    const ref = lastN[0];
    const matches = lastN.filter(t => Math.abs(t-ref) < 25).length;
    if (matches >= RTA_REPEAT_THRESH - 1) {
      alert(socketId, 'RTA_TIMING_PATTERN', SEV.MEDIUM,
        `${matches}/${RTA_REPEAT_THRESH} actions within 25ms of ${ref}ms — possible solver`,
        { ref, matches });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 2: GTO / Solver Statistical Analysis
// Compares player stats to known solver output ranges
// ══════════════════════════════════════════════════════════════════════════
// GTO ranges for reference (approximations):
// - VPIP: 22-28% (6-max), 15-20% (full ring)
// - PFR:  18-24% (6-max)
// - AF:   2.5-4.5 (balanced)
// - 3-bet: 7-12%
// Extreme outliers suggest solver assistance

function analyzePlayerStats(socketId) {
  const sess = getSession(socketId);
  if (sess.totalHands < 80) return; // need enough sample

  const vpip = sess.preflopVPIP / Math.max(sess.preflopTotal, 1);
  const pfr  = sess.preflopRaise / Math.max(sess.preflopTotal, 1);
  const af   = sess.aggrBets / Math.max(sess.aggrCalls, 1);
  const sdWR = sess.showdownWins / Math.max(sess.showdownTotal, 1);

  // Flag extremely narrow, solver-like ranges
  const vpipDev = Math.abs(vpip - 0.25);
  const pfrDev  = Math.abs(pfr - 0.20);

  if (vpipDev < 0.02 && pfrDev < 0.02 && sess.totalHands > 200) {
    alert(socketId, 'SOLVER_EXACT_RANGES', SEV.HIGH,
      `VPIP=${(vpip*100).toFixed(1)}% PFR=${(pfr*100).toFixed(1)}% — suspiciously close to GTO`,
      { vpip, pfr, af, hands: sess.totalHands });
  }
  // Inhuman aggression
  if (af > 8 && sess.aggrCalls > 30) {
    alert(socketId, 'SOLVER_AF', SEV.MEDIUM,
      `AF=${af.toFixed(1)} over ${sess.totalHands} hands — solver-level aggression`,
      { af, bets: sess.aggrBets, calls: sess.aggrCalls });
  }
  // Showdown win rate (GTO ≈ 52-56%)
  if (sdWR > 0.72 && sess.showdownTotal > 50) {
    alert(socketId, 'SUPERHUMAN_SD_WINRATE', SEV.MEDIUM,
      `Showdown WR=${(sdWR*100).toFixed(1)}% over ${sess.showdownTotal} showdowns`,
      { sdWR, showdownWins: sess.showdownWins, total: sess.showdownTotal });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 3: Collusion Graph Analysis
// Build win/loss graph — detect rings where chips flow one direction
// ══════════════════════════════════════════════════════════════════════════
function updateCollusionGraph(winnerName, loserName, amount) {
  if (!winnerName || !loserName) return;
  if (!collusionGraph[winnerName]) collusionGraph[winnerName] = { wins:{}, losses:{} };
  if (!collusionGraph[loserName])  collusionGraph[loserName]  = { wins:{}, losses:{} };
  collusionGraph[winnerName].wins[loserName]   = (collusionGraph[winnerName].wins[loserName]  ||0) + amount;
  collusionGraph[loserName].losses[winnerName] = (collusionGraph[loserName].losses[winnerName]||0) + amount;
}

function analyzeCollusionGraph(socketId, playerName) {
  const node = collusionGraph[playerName];
  if (!node) return;

  // Check: does one player always lose to the same opponent?
  for (const [loser, amt] of Object.entries(node.wins)) {
    const loserNode = collusionGraph[loser];
    if (!loserNode) continue;
    const loserTotalLoss = Object.values(loserNode.losses).reduce((a,b)=>a+b,0);
    const loserTotalWin  = Object.values(loserNode.wins).reduce((a,b)=>a+b,0);
    const pctToWinner    = amt / Math.max(loserTotalLoss, 1);
    // If >60% of loser's losses go to one player = suspicious
    if (pctToWinner > 0.60 && amt > 100) {
      [socketId, ...Object.keys(sessions).filter(id=>sessions[id]?.name===loser)].forEach(id => {
        if (!id) return;
        alert(id, 'COLLUSION_GRAPH', SEV.HIGH,
          `${loser} sent ${(pctToWinner*100).toFixed(0)}% of losses ($${amt.toFixed(0)}) to ${playerName}`,
          { winner:playerName, loser, amount:amt, pctToWinner });
      });
    }
  }

  // Detect 3-way ring: A→B→C→A (circular chip flow)
  for (const [b, abAmt] of Object.entries(node.wins)) {
    const bNode = collusionGraph[b];
    if (!bNode) continue;
    for (const [c, bcAmt] of Object.entries(bNode.wins)) {
      const cNode = collusionGraph[c];
      if (!cNode) continue;
      const caAmt = cNode.wins[playerName] || 0;
      if (abAmt > 50 && bcAmt > 50 && caAmt > 50) {
        alert(socketId, 'COLLUSION_RING', SEV.CRITICAL,
          `Circular chip flow: ${playerName}→${b}→${c}→${playerName} ($${abAmt.toFixed(0)}/$${bcAmt.toFixed(0)}/$${caAmt.toFixed(0)})`,
          { ring:[playerName,b,c], amounts:[abAmt,bcAmt,caAmt] });
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 4: Device Fingerprint Multi-Accounting
// ══════════════════════════════════════════════════════════════════════════
function checkFingerprint(socketId, fingerprint) {
  if (!fingerprint) return;
  const sess = getSession(socketId);
  sess.fingerprint = fingerprint;

  if (bannedFPs.has(fingerprint)) {
    return alert(socketId, 'BANNED_DEVICE', SEV.CRITICAL,
      `Device fingerprint ${fingerprint.slice(0,16)}... is banned`,
      { fingerprint });
  }

  if (!fpMap[fingerprint]) fpMap[fingerprint] = new Set();
  fpMap[fingerprint].add(socketId);

  const accounts = [...fpMap[fingerprint]].filter(id => id !== socketId && sessions[id]?.name);
  if (accounts.length >= 2) {
    const names = accounts.map(id => sessions[id]?.name).filter(Boolean);
    alert(socketId, 'DEVICE_MULTI_ACCOUNT', SEV.CRITICAL,
      `Same device fingerprint: ${[sessions[socketId]?.name, ...names].join(', ')}`,
      { fingerprint: fingerprint.slice(0,20), accounts: accounts.length+1, names });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 5: Velocity & Rate Limiting
// ══════════════════════════════════════════════════════════════════════════
const actionBuckets = {}; // socketId → timestamps[]

function checkVelocity(socketId) {
  const now = Date.now();
  if (!actionBuckets[socketId]) actionBuckets[socketId] = [];
  // Slide window: keep last 10 seconds
  actionBuckets[socketId] = actionBuckets[socketId].filter(t => now - t < 10000);
  actionBuckets[socketId].push(now);
  const rate = actionBuckets[socketId].length;
  if (rate > 25) {
    // >25 actions in 10s = scripted
    alert(socketId, 'ACTION_VELOCITY', SEV.HIGH,
      `${rate} actions in 10 seconds — scripted automation suspected`,
      { rate, window: '10s' });
    return false; // block action
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 6: Chip Dump — extended
// ══════════════════════════════════════════════════════════════════════════
const DUMP_THRESHOLD = 3;    // 3+ large losses to same player in 1hr
const DUMP_MIN_POT   = 15;   // ignore micro pots
const DUMP_STACK_PCT = 0.70; // lost ≥70% of stack

function checkChipDump(loserSocketId, winnerName, amount, loserStack) {
  const sess = getSession(loserSocketId);
  const now  = Date.now();
  sess.handResults.push({ to: winnerName, amount, ts: now });
  // Keep last 24h
  sess.handResults = sess.handResults.filter(r => now - r.ts < 86400000);

  // Rolling 1-hour check
  const hourCutoff = now - 3600000;
  const recentToSame = sess.handResults.filter(r => r.to === winnerName && r.ts > hourCutoff && r.amount >= DUMP_MIN_POT);
  const hourTotal = recentToSame.reduce((a,r) => a+r.amount, 0);

  if (recentToSame.length >= DUMP_THRESHOLD) {
    alert(loserSocketId, 'CHIP_DUMP_PATTERN', SEV.HIGH,
      `Lost to ${winnerName} ${recentToSame.length}× in 1hr ($${hourTotal.toFixed(0)} total)`,
      { winner: winnerName, count: recentToSame.length, total: hourTotal });
  }
  // Single-hand large loss
  if (loserStack > 0 && amount / loserStack >= DUMP_STACK_PCT && amount >= DUMP_MIN_POT) {
    alert(loserSocketId, 'CHIP_DUMP_LARGE', SEV.MEDIUM,
      `Lost ${Math.round(amount/loserStack*100)}% of stack ($${amount}) in one hand`,
      { amount, stack: loserStack, ratio: (amount/loserStack).toFixed(2) });
  }
  // Update graph
  updateCollusionGraph(winnerName, sess.name, amount);
  analyzeCollusionGraph(loserSocketId, winnerName);
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 7: Ghosting / Remote Coaching
// ══════════════════════════════════════════════════════════════════════════
function checkGhosting(socketId, elapsed, potSize, stackSize) {
  // Long pause on large decision + then perfect play — hard to prove,
  // but flag as risk marker for human review
  const bigPot = potSize / Math.max(stackSize, 1) > 0.35;
  if (elapsed > 20000 && bigPot) {
    alert(socketId, 'GHOSTING_RISK', SEV.LOW,
      `${(elapsed/1000).toFixed(0)}s pause on ${Math.round(potSize/stackSize*100)}% pot decision`,
      { elapsed, potSize, stackSize });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 8: IP / Same-table multi-accounting
// ══════════════════════════════════════════════════════════════════════════
function checkIPCollision(tableId, seats) {
  const ipGroups = {};
  for (const seat of seats) {
    const ip = sessions[seat.socketId]?.ip;
    if (!ip) continue;
    if (!ipGroups[ip]) ipGroups[ip] = [];
    ipGroups[ip].push({ socketId: seat.socketId, name: seat.name });
  }
  for (const [ip, players] of Object.entries(ipGroups)) {
    if (players.length >= 2) {
      players.forEach(p =>
        alert(p.socketId, 'SAME_IP_SAME_TABLE', SEV.HIGH,
          `${players.length} players at ${tableId} share IP ${ip}: ${players.map(x=>x.name).join(', ')}`,
          { ip, players: players.map(x=>x.name), tableId })
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 9: Suspicious chat patterns
// ══════════════════════════════════════════════════════════════════════════
const CHAT_COLLUSION = [
  /\bi\s*(have|got|hold)\s+(aces?|kings?|queens?|pair|flush|straight|full house|two pair)\b/i,
  /\b(fold|check|raise|bet|call)\s+(it|now|please|to\s+me|for\s+me)\b/i,
  /\b(dump|transfer|give\s+me|send\s+me)\s+chips?\b/i,
  /\bsign(al)?\s+when\b|\bcode\s+word\b/i,
  /\bwhat\s+(do\s+you\s+have|are\s+your\s+cards)\b/i,
];

function checkChat(socketId, message) {
  const sess = getSession(socketId);
  const now  = Date.now();
  sess.chatLog.push({ ts: now, msg: message });
  if (sess.chatLog.length > 200) sess.chatLog.shift();

  for (const pattern of CHAT_COLLUSION) {
    if (pattern.test(message)) {
      alert(socketId, 'CHAT_COLLUSION', SEV.MEDIUM,
        `Suspicious message: "${message.slice(0,80)}"`,
        { message, pattern: pattern.source });
      break;
    }
  }
  // Rapid chat flood
  const flood = sess.chatLog.filter(c => now - c.ts < 5000).length;
  if (flood > 10) {
    alert(socketId, 'CHAT_FLOOD', SEV.LOW,
      `${flood} messages in 5 seconds`,
      { count: flood });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// DETECTION 10: Multi-account via username similarity
// ══════════════════════════════════════════════════════════════════════════
function checkUsernameSimilarity(name) {
  const newNorm = name.toLowerCase().replace(/[^a-z]/g,'');
  for (const bannedN of bannedNames) {
    const bannedNorm = bannedN.replace(/[^a-z]/g,'');
    // Levenshtein distance ≤ 2 = evasion attempt
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

antiCheat.onConnect = (socketId, playerName, ip, fingerprint) => {
  const sess = getSession(socketId);
  sess.name = playerName; sess.ip = ip || 'unknown';

  // IP ban check
  if (bannedIPs.has(ip)) {
    alert(socketId,'BAN_EVASION_IP',SEV.CRITICAL,`Banned IP: ${ip}`,{ip});
    return { blocked:true, reason:'IP address is banned' };
  }
  // Name ban check + similarity
  if (bannedNames.has(playerName.toLowerCase())) {
    alert(socketId,'BAN_EVASION_NAME',SEV.CRITICAL,`Banned name: ${playerName}`,{playerName});
    return { blocked:true, reason:'Username is banned' };
  }
  const sim = checkUsernameSimilarity(playerName);
  if (sim.similar) {
    alert(socketId,'USERNAME_EVASION',SEV.HIGH,`"${playerName}" is similar to banned "${sim.to}"`,{playerName,similar:sim.to});
  }
  // Device fingerprint
  if (fingerprint) checkFingerprint(socketId, fingerprint);
  // IP multi-account
  if (!ipMap[ip]) ipMap[ip] = new Set();
  ipMap[ip].add(socketId);
  const others = [...ipMap[ip]].filter(id=>id!==socketId&&sessions[id]?.name);
  if (others.length >= 2) {
    const names = others.map(id=>sessions[id]?.name).filter(Boolean);
    alert(socketId,'MULTI_ACCOUNT_IP',SEV.HIGH,
      `IP ${ip} has ${others.length+1} active accounts: ${[...names,playerName].join(', ')}`,
      {ip,accounts:others.length+1,names:[...names,playerName]});
  }
  return { blocked:false };
};

antiCheat.onFingerprint = (socketId, fingerprint) => {
  checkFingerprint(socketId, fingerprint);
};

antiCheat.onAction = (socketId, action, tableId, ctx={}) => {
  const ok = checkVelocity(socketId);
  if (!ok) return false; // rate-limited

  const sess = getSession(socketId);
  const now  = Date.now();
  if (sess.lastActionTs) {
    const elapsed = now - sess.lastActionTs;
    _checkTiming(socketId, elapsed);
    if (ctx.potSize) checkGhosting(socketId, elapsed, ctx.potSize, ctx.stackSize||0);
  }
  sess.lastActionTs = now;
  sess.totalActions++;
  sess.actionCounts[action] = (sess.actionCounts[action]||0)+1;

  // VPIP/PFR tracking
  if (ctx.isPreflop && ctx.isFirstAction) {
    sess.preflopTotal++;
    if (action==='call'||action==='raise') sess.preflopVPIP++;
    if (action==='raise') sess.preflopRaise++;
  }
  // Aggression
  if (action==='raise') sess.aggrBets++;
  if (action==='call')  sess.aggrCalls++;
  // Periodic stats
  if (sess.totalActions>0 && sess.totalActions%25===0) analyzePlayerStats(socketId);
  return true;
};

antiCheat.onHandResult = (tableId, handData) => {
  const {winner,loser,winnerSocket,loserSocket,amount,isShowdown} = handData;
  const loserSess = sessions[loserSocket];
  if (loserSess && amount > 0) {
    loserSess.totalLost += amount;
    checkChipDump(loserSocket, winner, amount, loserSess.currentStack);
  }
  const winnerSess = sessions[winnerSocket];
  if (winnerSess) {
    winnerSess.totalWon += amount;
    winnerSess.handsPlayed++;
    if (isShowdown) { winnerSess.showdownWins++; winnerSess.showdownTotal++; }
  }
  if (loserSess && isShowdown) loserSess.showdownTotal++;
};

antiCheat.onJoinTable = (socketId, tableId, seats) => {
  const sess = getSession(socketId);
  sess.tableHistory.add(tableId);
  sess.currentTable = tableId;
  if (seats?.length) checkIPCollision(tableId, seats);
};

antiCheat.onLeaveTable  = (socketId) => { const s=getSession(socketId); s.currentTable=null; };
antiCheat.onChat        = (socketId, msg) => checkChat(socketId, msg);
antiCheat.onDisconnect  = (socketId) => {
  const sess = sessions[socketId];
  if (sess?.ip && ipMap[sess.ip]) { ipMap[sess.ip].delete(socketId); if(!ipMap[sess.ip].size) delete ipMap[sess.ip]; }
  if (sess?.fingerprint && fpMap[sess.fingerprint]) { fpMap[sess.fingerprint].delete(socketId); }
  delete actionBuckets[socketId];
  delete sessions[socketId];
};
antiCheat.setPlayerStack = (socketId, stack) => { if(sessions[socketId]) sessions[socketId].currentStack=stack; };

// Admin controls
antiCheat.banIP     = ip   => bannedIPs.add(ip);
antiCheat.banName   = name => bannedNames.add(name.toLowerCase());
antiCheat.banFP     = fp   => bannedFPs.add(fp);
antiCheat.unbanIP   = ip   => bannedIPs.delete(ip);
antiCheat.unbanName = name => bannedNames.delete(name.toLowerCase());

antiCheat.getAlerts = ({minSeverity=1,unreviewed=false,socketId=null,type=null}={}) => {
  let all = Object.values(flagged).flat();
  if (socketId) all = all.filter(a=>a.socketId===socketId);
  if (type)     all = all.filter(a=>a.type===type);
  if (unreviewed) all = all.filter(a=>!a.reviewed);
  return all.filter(a=>a.severity>=minSeverity).sort((a,b)=>b.ts-a.ts);
};

antiCheat.reviewAlert = (alertId, action, note='') => {
  for (const arr of Object.values(flagged)) {
    const a = arr.find(x=>x.id===alertId);
    if (a) { a.reviewed=true; a.action=action; a.adminNote=note; return a; }
  }
  return null;
};

antiCheat.getPlayerReport = socketId => {
  const sess = sessions[socketId]||{};
  const alerts = flagged[socketId]||[];
  const vpip = sess.preflopVPIP/Math.max(sess.preflopTotal,1);
  const pfr  = sess.preflopRaise/Math.max(sess.preflopTotal,1);
  const af   = sess.aggrBets/Math.max(sess.aggrCalls,1);
  return {
    ...sess, alerts, tableHistory:[...sess.tableHistory||[]],
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
      .map(s=>({ name:s.name, score:s.suspicionScore, alerts:(flagged[s.socketId]||[]).length, ip:s.ip })),
    collusionGraph:  Object.entries(collusionGraph).slice(0,20).map(([name,data])=>({
      name, topWin: Object.entries(data.wins).sort((a,b)=>b[1]-a[1])[0],
    })).filter(x=>x.topWin),
  };
};

antiCheat.SEV = SEV;

module.exports = { antiCheat };
