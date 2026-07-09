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
    t.prizePool = Math.floor(t.registeredPlayers.length * t.buyIn * 0.95 * 100) / 100; // 5% rake
    if (t.prizePool < t.guarantee) t.prizePool = t.guarantee;
    t.prizes = getPrizeStructure(t.registeredPlayers.length, t.prizePool, t.isSNG||false);
    return { ok:true, registered:t.registeredPlayers.length };
  },

  unregister(tournId, socketId, userId=null) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Tournament not found' };
    if (t.status !== 'registering' && t.status !== 'scheduled') return { ok:false, error:'Cannot unregister' };
    t.registeredPlayers = userId
      ? t.registeredPlayers.filter(p=>p.userId!==userId)
      : t.registeredPlayers.filter(p=>p.socketId!==socketId);
    t.prizePool = Math.floor(t.registeredPlayers.length * t.buyIn * 0.95 * 100) / 100;
    if (t.prizePool < t.guarantee) t.prizePool = t.guarantee;
    t.prizes = getPrizeStructure(t.registeredPlayers.length, t.prizePool, t.isSNG||false);
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
    t.prizePool = Math.floor(t.registeredPlayers.length * t.buyIn * 0.95 * 100) / 100;
    if (t.prizePool < t.guarantee) t.prizePool = t.guarantee;
    // Prefer the frozen template percentages if present; fall back to field-size defaults.
    if (t.prizePcts?.length) {
      t.prizes = t.prizePcts.map((pct, i) => ({
        place: i + 1, pct,
        amount: Math.floor(t.prizePool * pct / 100 * 100) / 100,
      }));
    } else {
      t.prizes = getPrizeStructure(t.registeredPlayers.length, t.prizePool, t.isSNG||false);
    }
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
    const players = [...t.registeredPlayers].filter(p=>!p.eliminated);
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

  _startBlindTimer(t, io, onTableState) {
    const { tableManager } = require('./tableManager');
    clearInterval(t.blindTimer);
    t.blindTimer = setInterval(() => {
      if (t.status !== 'running') return;
      t.blindLevel = Math.min(t.blindLevel + 1, STD_BLINDS.length - 1);
      const [sb, bb] = STD_BLINDS[t.blindLevel];
      // Update both the internal engine and the actual tableManager tables
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
    }, t.blindMins * 60 * 1000);
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
      results: t.results,
      tables: Object.keys(t.tables).length,
      startTime: t.startTime,
      createdAt: t.createdAt,
    };
  },

  _broadcastTournState(t, io) {
    const state = this.getState(t.id);
    // Broadcast to all registered players
    t.registeredPlayers.forEach(p => io.to(p.socketId).emit('tournState', state));
    // Also broadcast to admin room
    io.to('admin').emit('tournState', state);
  },
};

module.exports = { tournamentEngine, STD_BLINDS, getPrizeStructure };
