// ══════════════════════════════════════════════════════════════════════════
// Table Features — Time Bank, Run It Twice, Muck/Show, Rabbit Hunting
// ══════════════════════════════════════════════════════════════════════════
const { GameEngine } = require('./gameEngine');

// ── TIME BANK ─────────────────────────────────────────────────────────────
// Each player gets a shared pool of extra time they can spend on tough spots
// Default: 30s normal time + 60s bank. Using the bank emits timeBankUsed event.
const TIME_BANK_SECS = 60;  // total bank per session
const NORMAL_TURN_SECS = 25;

const timeBanks = {}; // socketId → seconds remaining

function getTimeBank(socketId) {
  if (timeBanks[socketId] === undefined) timeBanks[socketId] = TIME_BANK_SECS;
  return timeBanks[socketId];
}

function useTimeBank(socketId, seconds) {
  if (timeBanks[socketId] === undefined) timeBanks[socketId] = TIME_BANK_SECS;
  const used = Math.min(seconds, timeBanks[socketId]);
  timeBanks[socketId] = Math.max(0, timeBanks[socketId] - used);
  return { remaining: timeBanks[socketId], used };
}

function resetTimeBank(socketId) {
  timeBanks[socketId] = TIME_BANK_SECS;
}

function getTimeBankAll() { return { ...timeBanks }; }

// ── RUN IT TWICE ──────────────────────────────────────────────────────────
// When both players are all-in, offer to run the remaining board twice.
// Each board gets half the pot. If there's an odd amount, the first board gets it.
// pending: { tableId, engine, board, players, pot, offers: Set }
const ritPending = {}; // tableId → pending RIT state

function offerRunItTwice(tableId, engine, currentBoard, allInPlayers, pot) {
  ritPending[tableId] = {
    engine,
    board: [...currentBoard],
    players: allInPlayers, // [{ name, cards, socketId }]
    pot,
    offers: new Set(),     // socketIds who said yes
    declines: new Set(),   // socketIds who said no
    timeout: null,
  };
  return ritPending[tableId];
}

function respondRunItTwice(tableId, socketId, accept) {
  const rit = ritPending[tableId];
  if (!rit) return { ok: false, error: 'No RIT offer pending' };
  if (accept) rit.offers.add(socketId);
  else        rit.declines.add(socketId);
  const allResponded = rit.players.every(p =>
    rit.offers.has(p.socketId) || rit.declines.has(p.socketId)
  );
  if (!allResponded) return { ok: true, waiting: true };

  const unanimous = rit.players.every(p => rit.offers.has(p.socketId));
  clearTimeout(rit.timeout);

  if (!unanimous) {
    delete ritPending[tableId];
    return { ok: true, runTwice: false };
  }

  // Run it twice
  const result = executeRunItTwice(rit);
  delete ritPending[tableId];
  return { ok: true, runTwice: true, result };
}

function executeRunItTwice(rit) {
  const cardsNeeded = 5 - rit.board.length;
  if (cardsNeeded <= 0) return null; // board already complete

  // Board 1
  const eng1 = rit.engine;
  const board1 = [...rit.board];
  for (let i = 0; i < cardsNeeded; i++) board1.push(eng1.dealOne());

  // Board 2 — deal from same deck (cards already used are removed)
  const board2 = [...rit.board];
  for (let i = 0; i < cardsNeeded; i++) board2.push(eng1.dealOne());

  const halfPot1 = Math.floor(rit.pot / 2 * 100) / 100;
  const halfPot2 = rit.pot - halfPot1;

  const sd1 = eng1.showdown(rit.players, board1);
  const sd2 = eng1.showdown(rit.players, board2);

  return {
    board1, board2,
    result1: { winner: sd1.winner, hand: sd1.hand, amount: halfPot1 },
    result2: { winner: sd2.winner, hand: sd2.hand, amount: halfPot2 },
    totalByPlayer: buildTotals([sd1, sd2], [halfPot1, halfPot2]),
  };
}

function buildTotals(results, amounts) {
  const totals = {};
  results.forEach((r, i) => {
    totals[r.winner] = (totals[r.winner] || 0) + amounts[i];
  });
  return totals;
}

function cancelRunItTwice(tableId) {
  if (ritPending[tableId]) {
    clearTimeout(ritPending[tableId].timeout);
    delete ritPending[tableId];
  }
}

// ── MUCK / SHOW CARDS ─────────────────────────────────────────────────────
// When a player wins without showdown (others fold), they can choose to show or muck.
// Pending show decisions: tableId → { socketId, cards, timeout, cb }
const muckPending = {};

function offerMuckOrShow(tableId, socketId, cards, timeoutCb) {
  // Auto-muck after 8 seconds if no response
  const timer = setTimeout(() => {
    resolveMuck(tableId, socketId, false); // auto muck
    if (timeoutCb) timeoutCb(false);
  }, 8000);
  muckPending[tableId] = { socketId, cards, timer, timeoutCb };
}

function resolveMuck(tableId, socketId, show) {
  const pending = muckPending[tableId];
  if (!pending || pending.socketId !== socketId) return null;
  clearTimeout(pending.timer);
  delete muckPending[tableId];
  return { show, cards: show ? pending.cards : null };
}

// ── RABBIT HUNTING ────────────────────────────────────────────────────────
// After a hand ends (fold), deal the remaining board cards virtually.
// No effect on pot — purely informational.
// pending: { tableId, deck snapshot after hand ended }
const rabbitDecks = {}; // tableId → engine snapshot for rabbit

function saveRabbitDeck(tableId, engine, board) {
  rabbitDecks[tableId] = { engine, board: [...board] };
}

function doRabbitHunt(tableId) {
  const rabbit = rabbitDecks[tableId];
  if (!rabbit) return null;
  const board = [...rabbit.board];
  const needed = 5 - board.length;
  if (needed <= 0) return { ok: false, error: 'Board already complete' };
  const cards = [];
  for (let i = 0; i < needed; i++) cards.push(rabbit.engine.dealOne());
  delete rabbitDecks[tableId]; // one rabbit hunt per hand
  return { ok: true, rabbitCards: cards, fullBoard: [...board, ...cards] };
}

// ── EQUITY CALCULATOR ─────────────────────────────────────────────────────
// Monte Carlo simulation — run N random boards and count wins.
// Used for the hand strength indicator (equity % vs random hand).
function calcEquityVsRange(holeCards, board, numOpponents = 1, iterations = 800) {
  if (!holeCards || holeCards.length < 2) return { equity: 0, handName: '' };
  if (!board || board.length < 3) return { equity: 0, handName: '' }; // preflop — no calc

  const eng = new GameEngine(0.5, 1); // blinds don't matter for eval
  let wins = 0, ties = 0, total = 0;

  // Known cards
  const known = new Set([
    ...holeCards.map(c => c.r + c.s),
    ...board.map(c => c.r + c.s),
  ]);

  const allRanks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const allSuits = ['♠','♥','♦','♣'];
  const fullDeck = [];
  for (const r of allRanks) for (const s of allSuits) {
    const key = r + s;
    if (!known.has(key)) fullDeck.push({ r, s, red: s==='♥'||s==='♦' });
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Shuffle remaining deck
    const deck = [...fullDeck].sort(() => Math.random() - 0.5);
    let idx = 0;

    // Deal board cards
    const simBoard = [...board];
    while (simBoard.length < 5) simBoard.push(deck[idx++]);

    // Deal opponent hands
    const opponents = [];
    for (let o = 0; o < numOpponents; o++) {
      opponents.push({ name: `opp${o}`, cards: [deck[idx++], deck[idx++]], folded: false });
    }

    // Evaluate
    const hero = { name: 'hero', cards: holeCards, folded: false };
    const all = [hero, ...opponents];
    const result = eng.showdown(all, simBoard);
    if (result.winner === 'hero') wins++;
    else if (result.winner === null) ties += 0.5; // shouldn't happen but guard
    total++;
  }

  // Hand name from current board
  let handName = '';
  if (board.length >= 3) {
    const seven = [...holeCards, ...board];
    try {
      const res = eng.showdown([{ name: 'P', cards: holeCards, folded: false }], board);
      handName = res?.hand || '';
    } catch(_) {}
  }

  const equity = Math.round((wins + ties) / total * 100);
  return { equity, handName, wins, total };
}

module.exports = {
  // Time bank
  getTimeBank, useTimeBank, resetTimeBank, getTimeBankAll, TIME_BANK_SECS, NORMAL_TURN_SECS,
  // Run it twice
  offerRunItTwice, respondRunItTwice, cancelRunItTwice, executeRunItTwice,
  // Muck/show
  offerMuckOrShow, resolveMuck,
  // Rabbit hunting
  saveRabbitDeck, doRabbitHunt,
  // Equity
  calcEquityVsRange,
};
