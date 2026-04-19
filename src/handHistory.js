// ══════════════════════════════════════════════════════════════════════════
// Hand History — persistent storage & replay system
// Stores every hand with full action log, timestamps, hole cards
// ══════════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

const BASE_DIR    = process.env.RAILWAY_ENVIRONMENT ? path.join('/tmp', 'rfdata') : path.join(__dirname, '../../data');
const HISTORY_DIR = path.join(BASE_DIR, 'hands');
const INDEX_FILE  = path.join(BASE_DIR, 'hand_index.json');
const MAX_MEM     = 500; // keep last N hands in memory for fast lookup

// Ensure data directory exists
try { fs.mkdirSync(BASE_DIR,    { recursive: true }); } catch(_){}
try { fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch(_){}

let _handIndex = [];
let _memCache  = []; // recent hands in memory
let _handSeq   = 0;

// Load existing index on startup
try {
  const raw = fs.readFileSync(INDEX_FILE, 'utf8');
  _handIndex = JSON.parse(raw);
  _handSeq   = _handIndex.length;
  console.log(`[HandHistory] Loaded ${_handIndex.length} hand records`);
} catch(_) { _handIndex = []; }

// ── Active hand tracker ────────────────────────────────────────────────────
const activeHands = {}; // tableId → ActiveHand

function startHand(tableId, seats, blinds) {
  const handId = `H${String(++_handSeq).padStart(8,'0')}-${Date.now()}`;
  activeHands[tableId] = {
    handId,
    tableId,
    startTs:  Date.now(),
    blinds,   // { sb, bb }
    seats:    seats.map(s => ({ name:s.name, socketId:s.socketId, startStack:s.stack })),
    actions:  [],  // { ts, player, action, amount, pot, phase }
    board:    [],
    phase:    'preflop',
    finalPot: 0,
  };
  return handId;
}

function recordAction(tableId, player, action, amount, state) {
  const hand = activeHands[tableId];
  if (!hand) return;
  hand.actions.push({
    ts:     Date.now(),
    player,
    action,
    amount: amount || 0,
    pot:    state?.pot || 0,
    phase:  state?.phase || hand.phase,
  });
  if (state?.phase) hand.phase = state.phase;
  if (state?.board) hand.board = state.board.map(c => c.r + c.s);
}

function endHand(tableId, result) {
  const hand = activeHands[tableId];
  if (!hand) return null;

  const record = {
    ...hand,
    endTs:    Date.now(),
    duration: Date.now() - hand.startTs,
    winner:   result?.winner,
    handName: result?.hand,
    amount:   result?.amount,
    showCards:result?.showCards || [],
    finalBoard: result?.board?.map(c=>c.r+c.s) || hand.board,
    reason:   result?.reason,
  };

  // Write to disk
  _persistHand(record);
  // Add to memory cache
  _memCache.push(record);
  if (_memCache.length > MAX_MEM) _memCache.shift();

  delete activeHands[tableId];
  return record;
}

function _persistHand(record) {
  try {
    const filename = `${record.handId}.json`;
    fs.writeFileSync(path.join(HISTORY_DIR, filename), JSON.stringify(record, null, 2));
    // Update index
    const indexEntry = {
      handId:   record.handId,
      tableId:  record.tableId,
      ts:       record.startTs,
      winner:   record.winner,
      amount:   record.amount,
      players:  record.seats.map(s => s.name),
    };
    _handIndex.push(indexEntry);
    // Persist index (every 10 hands to reduce I/O)
    if (_handIndex.length % 10 === 0) _saveIndex();
  } catch(e) {
    console.error('[HandHistory] Write error:', e.message);
  }
}

function _saveIndex() {
  try { fs.writeFileSync(INDEX_FILE, JSON.stringify(_handIndex)); } catch(_){}
}

// ── Query API ──────────────────────────────────────────────────────────────
function getHand(handId) {
  // Check memory first
  const mem = _memCache.find(h => h.handId === handId);
  if (mem) return mem;
  // Load from disk
  try {
    const raw = fs.readFileSync(path.join(HISTORY_DIR, `${handId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch(_) { return null; }
}

function getPlayerHands(playerName, limit=50) {
  return _handIndex
    .filter(h => h.players.includes(playerName))
    .slice(-limit)
    .reverse()
    .map(h => getHand(h.handId))
    .filter(Boolean);
}

function getTableHands(tableId, limit=20) {
  return _handIndex
    .filter(h => h.tableId === tableId)
    .slice(-limit)
    .reverse()
    .map(h => getHand(h.handId))
    .filter(Boolean);
}

function getRecentHands(limit=50) {
  return _memCache.slice(-limit).reverse();
}

function getStats() {
  const total = _handIndex.length;
  const today = _handIndex.filter(h => h.ts > Date.now() - 86400000).length;
  const winners = {};
  _handIndex.forEach(h => { if(h.winner) winners[h.winner] = (winners[h.winner]||0)+1; });
  const topWinners = Object.entries(winners)
    .sort((a,b)=>b[1]-a[1]).slice(0,10)
    .map(([name,wins])=>({name,wins}));
  return { total, today, topWinners, cacheSize: _memCache.length };
}

// Replay: get full action-by-action sequence for a hand
function replayHand(handId) {
  const hand = getHand(handId);
  if (!hand) return null;
  return {
    meta:    { handId: hand.handId, tableId: hand.tableId, startTs: hand.startTs, duration: hand.duration },
    seats:   hand.seats,
    blinds:  hand.blinds,
    actions: hand.actions,
    board:   hand.finalBoard,
    result:  { winner: hand.winner, hand: hand.handName, amount: hand.amount, showCards: hand.showCards },
  };
}

// Shutdown: flush index
process.on('exit', _saveIndex);
process.on('SIGTERM', () => { _saveIndex(); process.exit(0); });
process.on('SIGINT',  () => { _saveIndex(); process.exit(0); });

module.exports = { startHand, recordAction, endHand, getHand, getPlayerHands, getTableHands, getRecentHands, getStats, replayHand };
