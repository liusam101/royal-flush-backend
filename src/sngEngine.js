// ══════════════════════════════════════════════════════════════════════════
// SNG Engine — Sits on top of tableManager to run Sit & Go tournaments
// Each SNG uses real tableManager tables for actual hand logic
// ══════════════════════════════════════════════════════════════════════════
const { tableManager } = require('./tableManager');

const sngs = {}; // sngId → SNG state

const SNG_BLINDS = [
  { sb:25,   bb:50   },
  { sb:50,   bb:100  },
  { sb:100,  bb:200  },
  { sb:150,  bb:300  },
  { sb:200,  bb:400  },
  { sb:300,  bb:600  },
  { sb:500,  bb:1000 },
  { sb:1000, bb:2000 },
];

const SNG_PRIZE_PCTS = {
  2: [100],
  3: [65, 35],
  6: [65, 35],
  9: [50, 30, 20],
};

// ── Create a new SNG ───────────────────────────────────────────────────────
function createSNG({ id, name, buyIn, startingStack, maxPlayers, blindMins, io }) {
  const tableId = `sng_${id}_${Date.now()}`;
  sngs[id] = {
    id, name, buyIn, startingStack, maxPlayers, blindMins,
    tableId,
    status: 'waiting', // waiting | starting | running | finished
    players: [],       // { socketId, name, chips }
    blindLevel: 0,
    blindTimer: null,
    prizePool: 0,
    prizes: [],
    io,
    eliminated: [],
  };

  // Create the real poker table with tournament chip stacks
  // Use tiny blinds to start — will be updated each level
  tableManager.createTable(tableId, {
    name,
    sb: SNG_BLINDS[0].sb,
    bb: SNG_BLINDS[0].bb,
    maxSeats: maxPlayers,
    min: startingStack * 0.1,
    max: startingStack * 10,
    isTournament: true,
  });

  return sngs[id];
}

// ── Register a player ──────────────────────────────────────────────────────
function registerPlayer(sngId, socketId, playerName) {
  const sng = sngs[sngId];
  if (!sng) return { ok: false, error: 'SNG not found' };
  if (sng.status !== 'waiting') return { ok: false, error: 'SNG already started' };
  if (sng.players.find(p => p.socketId === socketId)) return { ok: false, error: 'Already registered' };
  if (sng.players.length >= sng.maxPlayers) return { ok: false, error: 'SNG is full' };

  sng.players.push({ socketId, name: playerName, chips: sng.startingStack, eliminated: false });
  _recalcPrizes(sng);

  return { ok: true, registered: sng.players.length, max: sng.maxPlayers };
}

function _recalcPrizes(sng) {
  sng.prizePool = sng.players.length * sng.buyIn * 0.95; // 5% rake
  const n = sng.players.length;
  const pcts = SNG_PRIZE_PCTS[n <= 3 ? 3 : n <= 6 ? 6 : 9] || [100];
  sng.prizes = pcts.map((pct, i) => ({
    place: i + 1,
    amount: Math.floor(sng.prizePool * pct / 100 * 100) / 100,
  }));
}

// ── Start the SNG ──────────────────────────────────────────────────────────
function startSNG(sngId) {
  const sng = sngs[sngId];
  if (!sng) return { ok: false, error: 'SNG not found' };
  if (sng.players.length < 2) return { ok: false, error: 'Need at least 2 players' };

  sng.status = 'running';

  // Seat all players on the real table
  for (const player of sng.players) {
    const result = tableManager.joinTable(sng.tableId, player.socketId, player.name, player.chips);
    if (!result.ok) console.error(`[SNG] Failed to seat ${player.name}:`, result.error);
  }

  // Start blind timer
  _startBlindTimer(sng);

  return { ok: true, tableId: sng.tableId };
}

function _startBlindTimer(sng) {
  clearInterval(sng.blindTimer);
  sng.blindTimer = setInterval(() => {
    if (sng.status !== 'running') { clearInterval(sng.blindTimer); return; }
    sng.blindLevel = Math.min(sng.blindLevel + 1, SNG_BLINDS.length - 1);
    const blinds = SNG_BLINDS[sng.blindLevel];
    tableManager.updateBlinds(sng.tableId, blinds.sb, blinds.bb);
    if (sng.io) {
      sng.io.to('sng_' + sng.id).emit('sngBlindUp', {
        sngId: sng.id,
        level: sng.blindLevel,
        sb: blinds.sb,
        bb: blinds.bb,
      });
    }
  }, sng.blindMins * 60 * 1000);
}

// ── Called after each hand to check for eliminations ──────────────────────
function checkEliminations(sngId) {
  const sng = sngs[sngId];
  if (!sng || sng.status !== 'running') return [];

  const state = tableManager.getTableState(sng.tableId);
  if (!state) return [];

  const eliminated = [];

  // Check each player's chip count
  for (const player of sng.players) {
    if (player.eliminated) continue;
    const seat = state.seats.find(s => s.name === player.name);
    if (!seat || seat.stack === 0) {
      // Player is busted
      player.eliminated = true;
      player.chips = 0;
      const remaining = sng.players.filter(p => !p.eliminated);
      const place = remaining.length + 1;
      player.place = place;

      // Award prize
      const prize = sng.prizes.find(pr => pr.place === place);
      player.prize = prize ? prize.amount : 0;

      sng.eliminated.push({ name: player.name, place, prize: player.prize });
      eliminated.push({ socketId: player.socketId, name: player.name, place, prize: player.prize });

      // Remove from table
      tableManager.leaveTable(sng.tableId, player.socketId);
    } else {
      player.chips = seat.stack;
    }
  }

  // Check if SNG is over
  const remaining = sng.players.filter(p => !p.eliminated);
  if (remaining.length === 1) {
    const winner = remaining[0];
    winner.place = 1;
    const winPrize = sng.prizes.find(pr => pr.place === 1);
    winner.prize = winPrize ? winPrize.amount : sng.prizePool;
    sng.eliminated.push({ name: winner.name, place: 1, prize: winner.prize });
    sng.status = 'finished';
    clearInterval(sng.blindTimer);
    tableManager.leaveTable(sng.tableId, winner.socketId);
  }

  return eliminated;
}

// ── Get SNG state ──────────────────────────────────────────────────────────
function getState(sngId) {
  const sng = sngs[sngId];
  if (!sng) return null;
  return {
    id: sng.id,
    name: sng.name,
    status: sng.status,
    registered: sng.players.length,
    max: sng.maxPlayers,
    buyIn: sng.buyIn,
    prizePool: sng.prizePool,
    prizes: sng.prizes,
    blindLevel: sng.blindLevel,
    blinds: SNG_BLINDS[sng.blindLevel],
    players: sng.players.map(p => ({ name: p.name, chips: p.chips, eliminated: p.eliminated, place: p.place, prize: p.prize })),
    tableId: sng.tableId,
  };
}

function getSNG(sngId) { return sngs[sngId]; }
function getAllSNGs()   { return Object.values(sngs); }
function removeSNG(sngId) {
  const sng = sngs[sngId];
  if (sng) { clearInterval(sng.blindTimer); delete sngs[sngId]; }
}

module.exports = { createSNG, registerPlayer, startSNG, checkEliminations, getState, getSNG, getAllSNGs, removeSNG };
