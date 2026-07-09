// ══════════════════════════════════════════════════════════════════
// Tournament Engine — handles MTT lifecycle
// ══════════════════════════════════════════════════════════════════
const { GameEngine } = require('./gameEngine');

const tournaments = {};
let tIdCounter = 1;
const TOURN_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - TOURN_TTL_MS;
  Object.keys(tournaments).forEach(id => {
    const t = tournaments[id];
    if ((t.status === 'finished' || t.status === 'cancelled') && t.createdAt < cutoff) {
      clearInterval(t.blindTimer);
      delete tournaments[id];
    }
  });
}, 60 * 60 * 1000);

// SNG prize structures (small fields — fixed payouts)
const SNG_PRIZE_PCTS = {
  2: [65, 35],           // 2 players: top 1 paid... actually HU top 1 takes all
  3: [65, 35],           // 3 players: top 2 paid
  6: [65, 35],           // 6-max: top 2 paid
  9: [50, 30, 20],       // 9-max: top 3 paid
};

// MTT prize structures (large fields)
const MTT_PRIZE_PCTS = {
  2:  [65,35],
  3:  [50,30,20],
  5:  [40,25,18,12,5],
  9:  [35,20,14,10,7,5,4,3,2],
  18: [30,17,12,9,7,5,4,3,2.5,2,1.5,1.5,1,1,1,1,1,1],
  27: [25,15,10,8,6,4.5,3.5,3,2.5,2,1.5,1.5,1.3,1.2,1.1,1,0.9,0.9,0.8,0.8,0.7,0.7,0.7,0.6,0.6,0.6,0.5],
};

function getPrizeStructure(numPlayers, prizePool, isSNG=false) {
  if (isSNG) {
    // SNGs: fixed payout spots based on table size
    let pcts;
    if (numPlayers <= 3)       pcts = SNG_PRIZE_PCTS[3];
    else if (numPlayers <= 6)  pcts = SNG_PRIZE_PCTS[6];
    else                       pcts = SNG_PRIZE_PCTS[9];
    return pcts.map((pct, i) => ({
      place: i + 1, pct,
      amount: Math.floor(prizePool * pct / 100 * 100) / 100,
    }));
  }
  // MTT: payout % grows with field size
  const keys = Object.keys(MTT_PRIZE_PCTS).map(Number).sort((a,b)=>a-b);
  let pcts = MTT_PRIZE_PCTS[2];
  for (const k of keys) { if (numPlayers >= k) pcts = MTT_PRIZE_PCTS[k]; }
  return pcts.map((pct, i) => ({
    place: i + 1, pct,
    amount: Math.floor(prizePool * pct / 100 * 100) / 100,
  }));
}

const STD_BLINDS = [
  [25,50],[50,100],[75,150],[100,200],[150,300],[200,400],
  [300,600],[400,800],[600,1200],[1000,2000],[1500,3000],
  [2000,4000],[3000,6000],[5000,10000],[10000,20000],
];

// Fisher-Yates shuffle — used for random seat assignment across tables.
function _shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Recompute prize pool and prize breakdown for a tournament. Excludes bots since they
// don't put in a real buy-in. Prefers frozen template percentages when present.
function _recomputePrizes(t) {
  const humanCount = t.registeredPlayers.filter(p => !p.isBot).length;
  t.prizePool = Math.floor(humanCount * t.buyIn * 0.95 * 100) / 100; // 5% rake
  if (t.prizePool < t.guarantee) t.prizePool = t.guarantee;
  if (t.prizePcts?.length) {
    t.prizes = t.prizePcts.map((pct, i) => ({
      place: i + 1, pct,
      amount: Math.floor(t.prizePool * pct / 100 * 100) / 100,
    }));
  } else {
    t.prizes = getPrizeStructure(t.registeredPlayers.length, t.prizePool, t.isSNG||false);
  }
}

const tournamentEngine = {

  createTournament({ name, buyIn, startingStack=5000, blindMins=10, maxPlayers=100, guarantee=0, adminCreated=true }) {
    const id = 't' + (tIdCounter++);
    tournaments[id] = {
      id, name, buyIn, startingStack, blindMins, maxPlayers, guarantee,
      status: 'registering', // registering | running | paused | finished
      registeredPlayers: [], // { socketId, name, chips, tableId, seatIdx, eliminated, place, prize }
      tables: {},            // tableId → { seats: [{socketId, name, chips}], ...}
      blindLevel: 0,
      handCount: 0,
      startTime: null,
      blindTimer: null,
      prizePool: 0,
      prizes: [],
      results: [],           // [{place, name, prize}] — final standings
      adminCreated,
      createdAt: Date.now(),
    };
    return tournaments[id];
  },

  getAll() { return Object.values(tournaments); },
  get(id)  { return tournaments[id]; },

  register(tournId, socketId, playerName, userId=null) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Tournament not found' };
    if (t.status !== 'registering' && t.status !== 'scheduled') return { ok:false, error:'Registration closed' };
    if (t.registeredPlayers.length >= t.maxPlayers) return { ok:false, error:'Tournament full' };
    const isDup = userId
      ? t.registeredPlayers.find(p=>p.userId===userId)
      : t.registeredPlayers.find(p=>p.socketId===socketId);
    if (isDup) return { ok:false, error:'Already registered' };
    t.registeredPlayers.push({ userId, socketId, name:playerName, chips:t.startingStack, tableId:null, seatIdx:null, eliminated:false, place:null, prize:0 });
    _recomputePrizes(t);
    return { ok:true, registered:t.registeredPlayers.length };
  },

  // Re-entry: a busted player buys back in during the late-reg window. Resets their entry
  // to a fresh starting stack. Increments reentryCount. Returns { ok:true, late:true } on
  // success so the server layer can seat them at the smallest table.
  reenterPlayer(tournId, socketId, playerName, userId=null) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Tournament not found' };
    if (t.status !== 'running') return { ok:false, error:'Re-entry only during running tournament' };
    const player = userId
      ? t.registeredPlayers.find(p => p.userId === userId)
      : t.registeredPlayers.find(p => p.socketId === socketId);
    if (!player) return { ok:false, error:'Original entry not found' };
    if (!player.eliminated) return { ok:false, error:'You have not busted yet' };
    const allowed = t.reentriesAllowed ?? 0;
    if (allowed <= 0) return { ok:false, error:'Re-entry not allowed for this tournament' };
    player.reentryCount = (player.reentryCount || 0) + 1;
    if (player.reentryCount > allowed) return { ok:false, error:'Max re-entries reached' };
    // Restore player state to fresh.
    player.eliminated = false;
    player.place = null;
    player.prize = 0;
    player.chips = t.startingStack;
    player.tableId = null;
    player.seatIdx = null;
    player.socketId = socketId;
    _recomputePrizes(t);
    return { ok:true, late:true, reentryCount: player.reentryCount };
  },

  // Register a player AFTER the tournament has started (late reg window). Same shape as
  // register() but allows status='running' and does NOT re-seat the whole field.
  // The server layer must then seat this player at a specific table (smallest by default).
  registerLate(tournId, socketId, playerName, userId=null) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Tournament not found' };
    if (t.status !== 'running') return { ok:false, error:'Late reg only allowed while running' };
    if (t.registeredPlayers.length >= t.maxPlayers) return { ok:false, error:'Tournament full' };
    const isDup = userId
      ? t.registeredPlayers.find(p=>p.userId===userId && !p.eliminated)
      : t.registeredPlayers.find(p=>p.socketId===socketId && !p.eliminated);
    if (isDup) return { ok:false, error:'Already registered' };
    t.registeredPlayers.push({ userId, socketId, name:playerName, chips:t.startingStack, tableId:null, seatIdx:null, eliminated:false, place:null, prize:0 });
    _recomputePrizes(t);
    return { ok:true, registered:t.registeredPlayers.length, late:true };
  },

  unregister(tournId, socketId, userId=null) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Tournament not found' };
    if (t.status !== 'registering' && t.status !== 'scheduled') return { ok:false, error:'Cannot unregister' };
    t.registeredPlayers = userId
      ? t.registeredPlayers.filter(p=>p.userId!==userId)
      : t.registeredPlayers.filter(p=>p.socketId!==socketId);
    _recomputePrizes(t);
    return { ok:true };
  },

  // Update a registered player's socketId (e.g. on reconnect).
  updateSocketId(tournId, userId, newSocketId) {
    const t = tournaments[tournId];
    if (!t) return null;
    const p = t.registeredPlayers.find(pl => pl.userId === userId);
    if (!p) return null;
    p.socketId = newSocketId;
    return p;
  },

  // Persist an existing DB-backed tournament instance into memory.
  // row: a row from the `tournaments` table.
  hydrateFromRow(row) {
    const id = row.id;
    if (tournaments[id]) return tournaments[id];
    const rawPrize = row.prize_structure;
    const prizePcts = Array.isArray(rawPrize)
      ? rawPrize
      : (typeof rawPrize === 'string' ? JSON.parse(rawPrize) : []);
    tournaments[id] = {
      id,
      templateId: row.template_id || null,
      name: row.name,
      buyIn: Number(row.buy_in),
      startingStack: row.starting_stack,
      blindMins: row.blind_mins,
      maxPlayers: row.max_players,
      guarantee: Number(row.guarantee || 0),
      lateRegMins: row.late_reg_mins ?? 60,
      reentriesAllowed: row.reentries_allowed ?? 0,
      status: row.status,                  // 'scheduled' | 'registering' | 'running' | 'finished' | 'cancelled'
      registeredPlayers: [],
      tables: {},
      blindLevel: 0,
      handCount: 0,
      startTime: row.start_time ? new Date(row.start_time).getTime() : null,
      blindTimer: null,
      prizePool: 0,
      prizes: [],
      prizePcts,                            // frozen percentages from template
      results: [],
      adminCreated: false,
      persistent: true,
      createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    };
    return tournaments[id];
  },

  // Restore a registration from the DB ledger (bypasses status check).
  hydrateRegistration(tournId, userId, playerName) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Tournament not found' };
    if (t.registeredPlayers.find(p=>p.userId===userId)) return { ok:true }; // idempotent
    t.registeredPlayers.push({ userId, socketId: null, name:playerName, chips:t.startingStack, tableId:null, seatIdx:null, eliminated:false, place:null, prize:0 });
    _recomputePrizes(t);
    return { ok:true };
  },

  // Add a test bot player. Bots have no userId and no ledger entry — they don't inflate
  // the prize pool but they DO take seats, so a solo human can test against them.
  addBot(tournId, name) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Tournament not found' };
    if (t.registeredPlayers.length >= t.maxPlayers) return { ok:false, error:'Tournament full' };
    const botIdx = t.registeredPlayers.filter(p => p.isBot).length + 1;
    const socketId = 'bot_' + t.id.slice(-6) + '_' + botIdx + '_' + Date.now();
    const botName = name || ('Bot ' + botIdx);
    t.registeredPlayers.push({
      userId: null, socketId, name: botName, chips: t.startingStack,
      tableId: null, seatIdx: null, eliminated: false, place: null, prize: 0,
      isBot: true,
    });
    // NOTE: intentionally do NOT recalc prizePool — bots are seat-filler, not real money.
    return { ok:true, botCount: t.registeredPlayers.filter(p => p.isBot).length, total: t.registeredPlayers.length };
  },

  // Change a tournament's status without other side-effects. Server layer persists.
  setStatus(tournId, newStatus) {
    const t = tournaments[tournId];
    if (!t) return false;
    t.status = newStatus;
    return true;
  },

  start(tournId, io, onTableState) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Not found' };
    if (t.status === 'running' || t.status === 'finished') return { ok:false, error:'Already ' + t.status };
    if (t.registeredPlayers.length < 2) return { ok:false, error:'Need at least 2 players' };
    t.status = 'running';
    t.startTime = Date.now();
    t.blindLevel = 0;

    // Seat players across tables of up to 9
    this._seatPlayers(t);

    // Start blind timer
    this._startBlindTimer(t, io, onTableState);

    // Emit initial state to all players
    if (io) this._broadcastTournState(t, io);

    return { ok:true, tables:Object.keys(t.tables).length };
  },

  _seatPlayers(t) {
    const players = _shuffle([...t.registeredPlayers].filter(p=>!p.eliminated));
    const tableSize = 9;
    const numTables = Math.ceil(players.length / tableSize);
    t.tables = {};
    players.forEach((p, idx) => {
      const tableIdx = idx % numTables;
      const tid = `${t.id}_table${tableIdx}`;
      if (!t.tables[tid]) t.tables[tid] = { id:tid, seats:[], dealerIdx:0, engine:new GameEngine(STD_BLINDS[t.blindLevel][0], STD_BLINDS[t.blindLevel][1]) };
      t.tables[tid].seats.push({ socketId:p.socketId, name:p.name, chips:p.chips });
      p.tableId = tid;
      p.seatIdx = t.tables[tid].seats.length - 1;
    });
  },

  // ── Multi-table balancing (Phase 2A) ────────────────────────────────
  // Live counts per table from the actual tableManager state (excludes eliminated seats).
  _tableCounts(t, tableManager) {
    const counts = {};
    Object.keys(t.tables).forEach(tid => {
      const s = tableManager.getTableState(tid);
      counts[tid] = s ? s.seats.filter(x => !x.folded || x.stack > 0).length : 0;
      // Actually count all seats currently at the table (eliminated seats are removed)
      counts[tid] = s ? s.seats.length : 0;
    });
    return counts;
  },

  // Returns the tableId of the smallest table and biggest table.
  _extremeTables(counts) {
    let minTid = null, maxTid = null, minN = Infinity, maxN = -Infinity;
    for (const tid of Object.keys(counts)) {
      const n = counts[tid];
      if (n < minN) { minN = n; minTid = tid; }
      if (n > maxN) { maxN = n; maxTid = tid; }
    }
    return { minTid, minN, maxTid, maxN };
  },

  // Compute total non-eliminated players across all tournament tables.
  _totalRemaining(t) {
    return t.registeredPlayers.filter(p => !p.eliminated).length;
  },

  // Determine the list of table moves needed for balancing between hands.
  // Returns an array of { userId, socketId, fromTableId, toTableId, playerName, stack }
  // Balancing rule: if max_count - min_count >= 2, move one random player from max to min.
  // Table breaking: if any table has < 5 players AND we have more than one table, break it.
  // Final table consolidation: if total remaining <= 9 AND we have more than one table, break all.
  planTableMoves(tournId, tableManager) {
    const t = tournaments[tournId];
    if (!t || t.status !== 'running') return [];
    const tableIds = Object.keys(t.tables);
    if (tableIds.length <= 1) return [];

    const moves = [];
    const counts = this._tableCounts(t, tableManager);
    const totalRemaining = Object.values(counts).reduce((a,b)=>a+b, 0);

    // Final table consolidation — total remaining fits at one table.
    if (totalRemaining <= 9) {
      // Pick one table to survive (the one with the most players — fewer moves).
      const survivor = Object.keys(counts).sort((a,b) => counts[b]-counts[a])[0];
      for (const tid of tableIds) {
        if (tid === survivor) continue;
        const s = tableManager.getTableState(tid);
        if (!s) continue;
        for (const seat of s.seats) {
          moves.push({
            socketId: seat.socketId,
            name: seat.name,
            stack: seat.stack,
            fromTableId: tid,
            toTableId: survivor,
            reason: 'final_table',
          });
        }
      }
      return moves;
    }

    // Break any table under 5 seats — dismantle it, distribute players round-robin
    // to other tables (favouring smaller ones).
    for (const tid of tableIds) {
      if (counts[tid] === 0) continue;
      if (counts[tid] >= 5) continue;
      const s = tableManager.getTableState(tid);
      if (!s) continue;
      // Ensure we still have OTHER tables to move to.
      const otherTids = tableIds.filter(x => x !== tid && counts[x] > 0);
      if (!otherTids.length) continue;
      for (const seat of s.seats) {
        // Send to the smallest other table.
        const target = otherTids.sort((a,b) => counts[a]-counts[b])[0];
        counts[target]++;
        counts[tid]--;
        moves.push({
          socketId: seat.socketId,
          name: seat.name,
          stack: seat.stack,
          fromTableId: tid,
          toTableId: target,
          reason: 'table_broken',
        });
      }
    }
    if (moves.length) return moves;

    // Regular balancing — move one player from biggest table to smallest if diff >= 2.
    const { minTid, minN, maxTid, maxN } = this._extremeTables(counts);
    if (maxN - minN >= 2 && minTid && maxTid && minTid !== maxTid) {
      const s = tableManager.getTableState(maxTid);
      if (s?.seats?.length) {
        // Pick a random non-folded seat to move (avoid moving mid-hand fold state)
        const eligible = s.seats.filter(x => !x.folded && x.stack > 0);
        const pick = eligible[Math.floor(Math.random() * eligible.length)] || s.seats[0];
        moves.push({
          socketId: pick.socketId,
          name: pick.name,
          stack: pick.stack,
          fromTableId: maxTid,
          toTableId: minTid,
          reason: 'balance',
        });
      }
    }
    return moves;
  },

  // Apply a set of moves to both the tournamentEngine's `t.tables` bookkeeping AND
  // the actual tableManager tables. Returns { moves, brokenTables:[tid,...] }
  applyTableMoves(tournId, moves, tableManager) {
    const t = tournaments[tournId];
    if (!t) return { moves: [], brokenTables: [] };
    const brokenTables = new Set();
    for (const mv of moves) {
      // Remove from old table
      tableManager.leaveTable(mv.fromTableId, mv.socketId);
      // Update engine bookkeeping — find the registeredPlayer that owns this seat and re-point them
      const player = t.registeredPlayers.find(p => p.socketId === mv.socketId);
      if (player) {
        player.tableId = mv.toTableId;
      }
      // Seat at new table with the same stack
      tableManager.joinTable(mv.toTableId, mv.socketId, mv.name, mv.stack);
      // Update engine's t.tables[fromTableId].seats
      const from = t.tables[mv.fromTableId];
      if (from) from.seats = from.seats.filter(x => x.socketId !== mv.socketId);
      const to = t.tables[mv.toTableId];
      if (to) to.seats.push({ socketId: mv.socketId, name: mv.name, chips: mv.stack });
    }
    // Any source table that's now empty should be considered broken.
    Object.keys(t.tables).forEach(tid => {
      const s = tableManager.getTableState(tid);
      if (!s || s.seats.length === 0) {
        brokenTables.add(tid);
      }
    });
    // Remove broken tables from tournament bookkeeping.
    brokenTables.forEach(tid => {
      delete t.tables[tid];
      tableManager.removeTable(tid);
    });
    return { moves, brokenTables: [...brokenTables] };
  },

  _startBlindTimer(t, io, onTableState) {
    const { tableManager } = require('./tableManager');
    clearInterval(t.blindTimer);
    t.blindTimer = setInterval(() => {
      if (t.status !== 'running') return;
      if (t.onBreakUntil && Date.now() < t.onBreakUntil) return; // paused during break
      t.blindLevel = Math.min(t.blindLevel + 1, STD_BLINDS.length - 1);
      const [sb, bb] = STD_BLINDS[t.blindLevel];
      Object.keys(t.tables).forEach(tid => {
        tableManager.updateBlinds(tid, sb, bb);
      });
      if (io) {
        io.emit('tournBlindUp', {
          tournId: t.id,
          level: t.blindLevel,
          sb: STD_BLINDS[t.blindLevel][0],
          bb: STD_BLINDS[t.blindLevel][1],
        });
        this._broadcastTournState(t, io);
      }
      // Trigger a break every N blind levels (default: every 6 levels = ~60 min at 10-min levels).
      const breakEvery = t.breakEveryLevels || 6;
      const breakMs = (t.breakMins || 5) * 60 * 1000;
      if (t.blindLevel > 0 && t.blindLevel % breakEvery === 0 && !t.onBreakUntil) {
        this.startBreak(t.id, breakMs, io);
      }
    }, t.blindMins * 60 * 1000);
  },

  // Start a scheduled break: block new hands until onBreakUntil timestamp.
  // Auto-resumes after breakMs; blind timer keeps ticking but level advance is skipped.
  startBreak(tournId, breakMs, io) {
    const t = tournaments[tournId];
    if (!t || t.status !== 'running') return;
    t.onBreakUntil = Date.now() + breakMs;
    if (io) {
      io.emit('tournBreak', {
        tournId: t.id,
        breakUntil: t.onBreakUntil,
        breakMins: Math.round(breakMs / 60000),
      });
    }
    console.log(`[TournBreak] ${t.id} on break for ${Math.round(breakMs/60000)} min`);
    setTimeout(() => {
      const cur = tournaments[tournId];
      if (!cur) return;
      cur.onBreakUntil = null;
      if (io) io.emit('tournResume', { tournId: cur.id });
      console.log(`[TournBreak] ${cur.id} resumed`);
    }, breakMs);
  },

  isOnBreak(tournId) {
    const t = tournaments[tournId];
    return !!(t?.onBreakUntil && Date.now() < t.onBreakUntil);
  },

  // ── Bubble hand-for-hand (Phase 2B) ─────────────────────────────────
  // Bubble = one more elimination and everyone remaining is in the money.
  isOnBubble(tournId) {
    const t = tournaments[tournId];
    if (!t) return false;
    const paidSpots = (t.prizes || []).filter(p => p.pct > 0).length;
    if (paidSpots < 2) return false; // no bubble in HU tournaments
    const remaining = this._totalRemaining(t);
    return remaining === paidSpots + 1;
  },

  // Called by server when a table finishes a hand. Marks the table 'ready to start' next hand.
  // Returns true if this call should block (waiting on other tables), false if we should start.
  markTableReadyDuringBubble(tournId, tableId) {
    const t = tournaments[tournId];
    if (!t) return false;
    t._bubbleReady = t._bubbleReady || {};
    t._bubbleReady[tableId] = true;
    return true; // caller should wait; server checks all-ready separately
  },

  // Returns true if this table must currently wait (bubble mode + not all tables ready yet).
  isBubbleWaiting(tournId, tableId) {
    const t = tournaments[tournId];
    if (!t || !this.isOnBubble(tournId)) return false;
    // Wait if not all tables have reported ready.
    const readyMap = t._bubbleReady || {};
    const activeTids = Object.keys(t.tables);
    for (const tid of activeTids) {
      if (!readyMap[tid]) return true;
    }
    // All ready — clear the map and let the next tryStartNewHand proceed.
    return false;
  },

  clearBubbleReady(tournId) {
    const t = tournaments[tournId];
    if (t) t._bubbleReady = {};
  },

  eliminatePlayer(tournId, socketId) {
    const t = tournaments[tournId];
    if (!t) return;
    const player = t.registeredPlayers.find(p=>p.socketId===socketId);
    if (!player || player.eliminated) return;
    player.eliminated = true;
    const remaining = t.registeredPlayers.filter(p=>!p.eliminated);
    player.place = remaining.length + 1;
    // Award prize if in the money
    const prize = t.prizes.find(pr=>pr.place===player.place);
    if (prize) { player.prize = prize.amount; }
    t.results.unshift({ place:player.place, name:player.name, prize:player.prize||0 });
    // Check if tournament over
    if (remaining.length === 1) {
      const winner = remaining[0];
      winner.place = 1;
      const winPrize = t.prizes.find(pr=>pr.place===1);
      if (winPrize) winner.prize = winPrize.amount;
      t.results.unshift({ place:1, name:winner.name, prize:winner.prize||0 });
      t.status = 'finished';
      clearInterval(t.blindTimer);
    }
    return { eliminated:player.name, place:player.place, prize:player.prize, remaining:remaining.length };
  },

  pause(tournId)  { const t=tournaments[tournId]; if(t){ t.status='paused'; clearInterval(t.blindTimer); } },
  resume(tournId, io, cb) {
    const t=tournaments[tournId];
    if(!t) return;
    t.status='running';
    this._startBlindTimer(t, io, cb);
  },
  cancel(tournId) {
    const t=tournaments[tournId];
    if(!t) return;
    t.status='cancelled';
    clearInterval(t.blindTimer);
  },
  delete(tournId) { clearInterval(tournaments[tournId]?.blindTimer); delete tournaments[tournId]; },

  getState(tournId) {
    const t = tournaments[tournId];
    if (!t) return null;
    const remaining = t.registeredPlayers.filter(p=>!p.eliminated).length;
    // Live leaderboard: top-10 chip leaders across all tables. Source of truth is tableManager.
    let leaderboard = [];
    let avgStack = 0;
    if (t.status === 'running' && t.tables && Object.keys(t.tables).length) {
      try {
        const { tableManager } = require('./tableManager');
        const allSeats = [];
        Object.keys(t.tables).forEach(tid => {
          const s = tableManager.getTableState(tid);
          if (!s?.seats) return;
          s.seats.forEach(seat => allSeats.push({ name: seat.name, chips: seat.stack, tableId: tid }));
        });
        allSeats.sort((a, b) => b.chips - a.chips);
        leaderboard = allSeats.slice(0, 10);
        if (allSeats.length) avgStack = Math.round(allSeats.reduce((sum, s) => sum + s.chips, 0) / allSeats.length);
      } catch(_) { /* tableManager not yet loaded */ }
    }
    return {
      id: t.id, name: t.name, status: t.status,
      buyIn: t.buyIn, startingStack: t.startingStack,
      blindLevel: t.blindLevel,
      sb: STD_BLINDS[t.blindLevel][0], bb: STD_BLINDS[t.blindLevel][1],
      blindMins: t.blindMins, maxPlayers: t.maxPlayers,
      registered: t.registeredPlayers.length,
      remaining, eliminated: t.registeredPlayers.length - remaining,
      prizePool: t.prizePool, prizes: t.prizes,
      guarantee: t.guarantee,
      lateRegMins: t.lateRegMins,
      reentriesAllowed: t.reentriesAllowed,
      onBreakUntil: t.onBreakUntil || null,
      onBubble: this.isOnBubble(tournId),
      leaderboard,
      avgStack,
      results: t.results,
      tables: Object.keys(t.tables).length,
      startTime: t.startTime,
      createdAt: t.createdAt,
    };
  },

  _broadcastTournState(t, io) {
    const state = this.getState(t.id);
    // Broadcast to all registered human players (bots have synthetic socketIds).
    t.registeredPlayers.forEach(p => {
      if (p.isBot || !p.socketId) return;
      io.to(p.socketId).emit('tournState', state);
    });
    io.to('admin').emit('tournState', state);
  },
};

module.exports = { tournamentEngine, STD_BLINDS, getPrizeStructure };
