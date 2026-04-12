// ══════════════════════════════════════════════════════════════════
// Tournament Engine — handles MTT lifecycle
// ══════════════════════════════════════════════════════════════════
const { GameEngine } = require('./gameEngine');

const tournaments = {};
let tIdCounter = 1;

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

  register(tournId, socketId, playerName) {
    const t = tournaments[tournId];
    if (!t) return { ok:false, error:'Tournament not found' };
    if (t.status !== 'registering') return { ok:false, error:'Registration closed' };
    if (t.registeredPlayers.length >= t.maxPlayers) return { ok:false, error:'Tournament full' };
    if (t.registeredPlayers.find(p=>p.socketId===socketId)) return { ok:false, error:'Already registered' };
    t.registeredPlayers.push({ socketId, name:playerName, chips:t.startingStack, tableId:null, seatIdx:null, eliminated:false, place:null, prize:0 });
    t.prizePool = Math.floor(t.registeredPlayers.length * t.buyIn * 0.95 * 100) / 100; // 5% rake
    if (t.prizePool < t.guarantee) t.prizePool = t.guarantee;
    t.prizes = getPrizeStructure(t.registeredPlayers.length, t.prizePool, t.isSNG||false);
    return { ok:true, registered:t.registeredPlayers.length };
  },

  unregister(tournId, socketId) {
    const t = tournaments[tournId];
    if (!t || t.status !== 'registering') return { ok:false, error:'Cannot unregister' };
    t.registeredPlayers = t.registeredPlayers.filter(p=>p.socketId!==socketId);
    t.prizePool = Math.floor(t.registeredPlayers.length * t.buyIn * 0.95 * 100) / 100;
    if (t.prizePool < t.guarantee) t.prizePool = t.guarantee;
    t.prizes = getPrizeStructure(t.registeredPlayers.length, t.prizePool, t.isSNG||false);
    return { ok:true };
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
    clearInterval(t.blindTimer);
    t.blindTimer = setInterval(() => {
      if (t.status !== 'running') return;
      t.blindLevel = Math.min(t.blindLevel + 1, STD_BLINDS.length - 1);
      // Update all table engines with new blinds
      Object.values(t.tables).forEach(tbl => {
        tbl.engine = new GameEngine(STD_BLINDS[t.blindLevel][0], STD_BLINDS[t.blindLevel][1]);
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
