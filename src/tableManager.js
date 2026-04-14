const { GameEngine } = require('./gameEngine');

const tables = {};

const DEFAULT_TABLES = [
  { id: 'midnight-velvet', name: 'Midnight Velvet', sb: 0.25, bb: 0.5,  maxSeats: 6 },
  { id: 'cursed-domain',   name: 'Cursed Domain',   sb: 0.5,  bb: 1.0,  maxSeats: 6 },
  { id: 'grand-royal',     name: 'Grand Royal',      sb: 2.5,  bb: 5.0,  maxSeats: 9 },
];

DEFAULT_TABLES.forEach(t => {
  tables[t.id] = {
    id: t.id, name: t.name, sb: t.sb, bb: t.bb, maxSeats: t.maxSeats,
    seats: [], engine: new GameEngine(t.sb, t.bb),
    phase: 'waiting', pot: 0, sidePots: [], board: [],
    actIdx: 0, dealerIdx: 0,
    lastRaiseSize: 0, bbIdx: 0, preflopBBActed: false, actionsThisRound: 0, roundStartIdx: -1,
  };
});

// ── Side pot calculation ──────────────────────────────────────────────────────
// Returns array of {amount, eligible: [seatIndices]}
function calcSidePots(seats) {
  const active = seats.map((s, i) => ({ idx: i, totalBet: s.totalBet || 0, folded: s.folded }))
    .filter(s => !s.folded && s.totalBet > 0);

  if (!active.length) return [];

  // Sort by total bet ascending
  const sorted = [...active].sort((a, b) => a.totalBet - b.totalBet);
  const pots = [];
  let prev = 0;

  sorted.forEach((player, i) => {
    const level = player.totalBet;
    if (level <= prev) return;
    const eligible = sorted.slice(i).map(p => p.idx); // everyone at this level or higher
    const contributors = seats.filter((s, idx) => !s.folded && (s.totalBet || 0) >= level);
    const potAmount = (level - prev) * contributors.length;
    // Also add folded players' contributions at this level
    const foldedContrib = seats.reduce((sum, s, idx) => {
      if (!s.folded) return sum;
      return sum + Math.min(Math.max(0, (s.totalBet||0) - prev), level - prev);
    }, 0);
    pots.push({ amount: potAmount + foldedContrib, eligible });
    prev = level;
  });

  return pots;
}

// ── Showdown with side pots ───────────────────────────────────────────────────
function showdownWithSidePots(engine, seats, board) {
  // Calculate side pots based on totalBet
  const sidePots = calcSidePots(seats);
  const results = [];
  let totalAwarded = 0;

  for (const pot of sidePots) {
    const eligibleSeats = pot.eligible
      .map(i => seats[i])
      .filter(s => !s.folded && s.cards && s.cards.length >= 2);

    if (!eligibleSeats.length) continue;

    if (eligibleSeats.length === 1) {
      eligibleSeats[0].stack += pot.amount;
      results.push({ winner: eligibleSeats[0].name, amount: pot.amount, hand: 'uncontested' });
      totalAwarded += pot.amount;
      continue;
    }

    // Find best hand among eligible
    let winner = null, winScore = null;
    for (const seat of eligibleSeats) {
      const seven = [...seat.cards, ...board];
      if (seven.length < 5) continue;
      const result = engine.bestFivePublic ? engine.bestFivePublic(seven) : null;
      if (!result) continue;
      if (!winScore || engine.comparePublic(result.score, winScore) > 0) {
        winner = seat; winScore = result.score;
      }
    }

    if (winner) {
      winner.stack += pot.amount;
      results.push({ winner: winner.name, amount: pot.amount, hand: winScore?.name });
      totalAwarded += pot.amount;
    }
  }

  return { results, mainWinner: results[results.length - 1]?.winner || results[0]?.winner };
}

const tableManager = {

  // Register auto-fold callback
  onAutoFold(tableId, cb) {
    if (tables[tableId]) tables[tableId]._onAutoFold = cb;
  },

  // Create a new dynamic table (for SNGs/tournaments)
  createTable(tableId, { name, sb, bb, maxSeats, isTournament=false }) {
    if (tables[tableId]) return; // already exists
    tables[tableId] = {
      id: tableId, name, sb, bb, maxSeats,
      seats: [], engine: new GameEngine(sb, bb),
      phase: 'waiting', pot: 0, sidePots: [], board: [],
      actIdx: 0, dealerIdx: 0, isTournament,
      lastRaiseSize: 0, bbIdx: 0, preflopBBActed: false, actionsThisRound: 0, roundStartIdx: -1,
    };
  },

  // Update blinds (for tournament blind levels)
  updateBlinds(tableId, sb, bb) {
    const t = tables[tableId];
    if (!t) return;
    t.sb = sb; t.bb = bb;
    t.engine = new GameEngine(sb, bb);
  },

  // Remove a table
  removeTable(tableId) {
    delete tables[tableId];
  },

  getTableList() {
    return Object.values(tables)
      .filter(t => !t.isTournament)
      .map(t => ({
        id: t.id, name: t.name, sb: t.sb, bb: t.bb,
        players: t.seats.length, maxSeats: t.maxSeats,
        rakeCollected: t._rakeCollected || 0,
      }));
  },



  getTotalRake() {
    return Object.values(tables).reduce((sum, t) => sum + (t._rakeCollected || 0), 0);
  },

  getTableState(tableId) {
    const t = tables[tableId];
    if (!t) return null;
    const maxBet = t.seats.length ? Math.max(0, ...t.seats.map(s => s.bet||0)) : 0;
    const inProgress = t.phase !== 'waiting' && t.phase !== 'starting';
    return {
      id: t.id, name: t.name, phase: t.phase, pot: t.pot,
      sb: t.sb, bb: t.bb, maxSeats: t.maxSeats,
      board: t.board, sidePots: t.sidePots || [],
      seats: t.seats.map((s, i) => ({
        seat:     s.seat,
        name:     s.name,
        stack:    s.stack,
        bet:      s.bet || 0,
        folded:   !!s.folded,
        allIn:    s.stack === 0 && !s.folded,
        acting:   inProgress && i === t.actIdx && !s.folded,
        isDealer: i === t.dealerIdx,
        sitOut:   !!s.sitOut,
        // toCall capped at player stack
        toCall: (inProgress && i === t.actIdx)
          ? Math.min(s.stack, Math.max(0, maxBet - (s.bet||0)))
          : 0,
      })),
    };
  },

  joinTable(tableId, socketId, playerName, buyIn) {
    const t = tables[tableId];
    if (!t) return { ok: false, error: 'Table not found' };
    const existing = t.seats.find(s => s.socketId === socketId);
    if (existing) return { ok: true, seat: existing.seat, cards: existing.cards, alreadyJoined: true, willStartHand: false };
    if (t.seats.length >= t.maxSeats) {
      return { ok: false, error: 'Table is full', tableFull: true };
    }
    if (buyIn < t.bb * 20) return { ok: false, error: `Min buy-in is $${t.bb * 20}` };

    const seatIdx = t.seats.length;
    t.seats.push({ socketId, name: playerName, stack: buyIn, seat: seatIdx, bet: 0, totalBet: 0, folded: false, cards: [] });

    const willStartHand = (t.seats.length === 2 && t.phase === 'waiting');
    if (willStartHand) {
      setTimeout(() => {
        if (tables[tableId]?.seats.length >= 2 && tables[tableId].phase === 'waiting') {
          this._startHand(tableId);
        }
      }, 800);
    }
    return { ok: true, seat: seatIdx, cards: [], willStartHand };
  },

  leaveTable(tableId, socketId) {
    const t = tables[tableId];
    if (!t) return;
    // No waiting list — new tables spawn automatically when full

    // If hand is in progress and there's a pot, award it to remaining player
    const inProgress = t.phase !== 'waiting' && t.phase !== 'starting';
    if (inProgress && t.pot > 0) {
      // Refund everyone's bets back to their stacks before clearing
      t.seats.forEach(s => {
        if (s.socketId !== socketId) {
          // Remaining players get their bets back + the pot
          s.stack += s.bet || 0;
        }
        // Give pot to first remaining non-leaving player
      });
      // Award pot to first remaining player who isn't leaving
      const remaining = t.seats.filter(s => s.socketId !== socketId && !s.folded);
      if (remaining.length === 1) {
        remaining[0].stack += t.pot;
      } else if (remaining.length > 1) {
        // Multiple players remain — just refund everyone's bets
        remaining.forEach(s => { /* already done above */ });
        remaining[0].stack += t.pot; // give pot to first active
      }
      t.pot = 0;
    }

    // Clear any auto-fold timers for the leaving player
    const leaving = t.seats.find(s => s.socketId === socketId);
    if (leaving?._autoFoldTimer) { clearTimeout(leaving._autoFoldTimer); }

    t.seats = t.seats.filter(s => s.socketId !== socketId);
    t.seats.forEach((s, i) => { s.seat = i; });
    if (t.seats.length < 2) {
      t.phase = 'waiting'; t.pot = 0; t.board = []; t.sidePots = [];
      t.seats.forEach(s => { s.bet = 0; s.totalBet = 0; s.folded = false; s.cards = []; });
    }
    if (t.actIdx    >= t.seats.length) t.actIdx    = 0;
    if (t.dealerIdx >= t.seats.length) t.dealerIdx = 0;
  },

  removePlayer(socketId) {
    const affected = [];
    Object.keys(tables).forEach(tid => {
      if (tables[tid].seats.find(s => s.socketId === socketId)) {
        this.leaveTable(tid, socketId);
        affected.push(tid);
      }
    });
    return affected;
  },

  setSitOut(tableId, socketId, sitOut) {
    const t = tables[tableId];
    if (!t) return;
    const seat = t.seats.find(s => s.socketId === socketId);
    if (seat) seat.sitOut = sitOut;
  },

  handleAction(tableId, socketId, action, amount) {
    const t = tables[tableId];
    if (!t) return { ok: false, error: 'Table not found' };
    if (t.phase === 'waiting' || t.phase === 'starting') return { ok: false, error: 'No hand in progress' };

    const actor = t.seats[t.actIdx];
    if (!actor || actor.socketId !== socketId) return { ok: false, error: 'Not your turn' };

    const maxBet = Math.max(0, ...t.seats.map(s => s.bet||0));
    const toCall = Math.min(actor.stack, Math.max(0, maxBet - (actor.bet||0)));

    // Clear auto-fold timer if they acted
    if (actor._autoFoldTimer) { clearTimeout(actor._autoFoldTimer); actor._autoFoldTimer = null; }

    if (action === 'fold') {
      actor.folded = true;
    } else if (action === 'check') {
      if (toCall > 0) return { ok: false, error: `Must call $${toCall.toFixed(2)} or fold` };
    } else if (action === 'call') {
      const pay = Math.min(toCall, actor.stack);
      actor.stack -= pay;
      actor.bet = (actor.bet||0) + pay;
      actor.totalBet = (actor.totalBet||0) + pay;
      t.pot += pay;
    } else if (action === 'raise') {
      // Check straddle BEFORE updating bet (straddle = first raise preflop from bet=0)
      const isBlindRaise = t.phase === 'preflop' && (actor.bet || 0) === 0;
      const minRaise  = Math.max(t.bb, t.lastRaiseSize || t.bb);
      const minTotal  = maxBet + minRaise;
      const reqTotal  = Math.max(minTotal, Number(amount) || minTotal);
      const total     = Math.min(reqTotal, actor.stack + (actor.bet||0));
      t.lastRaiseSize = total - maxBet;
      const extra     = total - (actor.bet||0);
      actor.stack    -= Math.max(0, extra);
      actor.totalBet  = (actor.totalBet||0) + Math.max(0, extra);
      actor.bet       = total;
      t.pot          += Math.max(0, extra);
      t.preflopBBActed = false;
      t._straddleActive = isBlindRaise;
      t.actionsThisRound = 0; // Reset — raise counts as 1 via the increment below
      t.roundStartIdx = t.actIdx;
    }

    if (t.phase === 'preflop' && t.actIdx === t.bbIdx) t.preflopBBActed = true;
    t.actionsThisRound = (t.actionsThisRound||0) + 1;
    if (t.roundStartIdx === -1) t.roundStartIdx = t.actIdx;

    // Only one active player left → wins immediately
    const active = t.seats.filter(s => !s.folded);
    if (active.length === 1) {
      // Rake on fold wins too (but only if pot is big enough)
      let foldRake = 0;
      if (!t.isTournament && t.pot >= 1) {
        foldRake = Math.min(Math.round(t.pot * 0.025 * 100) / 100, 3.00);
        t._rakeCollected = (t._rakeCollected || 0) + foldRake;
      }
      active[0].stack += (t.pot - foldRake);
      const handResult = { winner: active[0].name, amount: t.pot - foldRake, rake: foldRake, reason: 'others folded' };
      this._resetHand(tableId);
      return { ok: true, handOver: true, handResult };
    }

    this._nextActor(tableId);

    if (this._bettingDone(tableId)) {
      // All-in runout — everyone remaining is all-in
      const canAct = t.seats.filter(s => !s.folded && s.stack > 0);
      if (canAct.length <= 1) {
        const result = this._runItOut(tableId);
        if (result) return { ok: true, handOver: true, handResult: result };
      }
      const over = this._advancePhase(tableId);
      if (over) return { ok: true, handOver: true, handResult: over };
    }

    return { ok: true, handOver: false };
  },

  getPlayerCards(tableId) {
    const t = tables[tableId];
    if (!t) return [];
    return t.seats.map(s => ({ socketId: s.socketId, cards: s.cards || [] }));
  },

  startNewHandAndDeal(tableId) {
    const t = tables[tableId];
    if (!t || t.seats.length < 2) return null;
    if (t.phase === 'starting' || t.phase === 'waiting') this._startHand(tableId);
    return t.seats.map(s => ({ socketId: s.socketId, cards: s.cards }));
  },

  _runItOut(tableId) {
    const t = tables[tableId];
    t.seats.forEach(s => s.bet = 0);
    while (t.board.length < 5) t.board.push(t.engine.dealOne());
    console.log(`    [${tableId}] All-in runout | board: ${t.board.map(c=>c.r+c.s).join(' ')}`);
    return this._doShowdown(tableId);
  },

  _doShowdown(tableId) {
    const t = tables[tableId];
    // Use side pot logic
    const active = t.seats.filter(s => !s.folded && s.cards && s.cards.length >= 2);

    if (active.length === 0) {
      this._resetHand(tableId);
      return null;
    }

    if (active.length === 1) {
      active[0].stack += t.pot;
      const handResult = { winner: active[0].name, amount: t.pot, reason: 'last player' };
      this._resetHand(tableId);
      return handResult;
    }

    // Calculate side pots
    const sidePots = calcSidePots(t.seats);
    let totalPot = t.pot;
    const allResults = [];

    if (sidePots.length <= 1) {
      // Simple case — single pot
      const result = t.engine.showdown(active, t.board);
      const winner = active.find(s => s.name === result.winner);
      if (winner) winner.stack += totalPot;
      // Include all players' hole cards so clients can flip them at showdown
      // ── Rake: 2.5% of pot, capped at $3 (exempt: tournaments, pots < $1)
      let rake = 0;
      if (!t.isTournament && totalPot >= 1) {
        rake = Math.min(Math.round(totalPot * 0.025 * 100) / 100, 3.00);
        // Deduct rake from winner's share
        active[0].stack = Math.max(0, active[0].stack - rake);
        t._rakeCollected = (t._rakeCollected || 0) + rake;
      }
      const showCards = active.map(s => ({ name: s.name, cards: s.cards }));
      const handResult = { winner: result.winner, hand: result.hand, amount: totalPot - rake, rake, board: t.board, showCards };
      this._resetHand(tableId);
      return handResult;
    }

    // Multiple side pots
    let lastWinner = null, lastHand = null, lastAmount = 0;
    for (const sp of sidePots) {
      const eligible = sp.eligible.map(i => t.seats[i]).filter(s => !s.folded && s.cards && s.cards.length >= 2);
      if (!eligible.length) continue;
      const result = t.engine.showdown(eligible, t.board);
      const winner = eligible.find(s => s.name === result.winner);
      if (winner) {
        winner.stack += sp.amount;
        lastWinner = result.winner;
        lastHand = result.hand;
        lastAmount += sp.amount;
      }
      allResults.push({ winner: result.winner, hand: result.hand, amount: sp.amount });
    }

    // Main result = whoever won the most (last side pot winner for display)
    const showCards2 = t.seats.filter(s => !s.folded && s.cards?.length).map(s => ({ name: s.name, cards: s.cards }));
    const handResult = {
      winner: lastWinner,
      hand: lastHand,
      amount: lastAmount,
      sidePots: allResults,
      board: t.board,
      showCards: showCards2,
    };
    this._resetHand(tableId);
    return handResult;
  },

  _startHand(tableId) {
    const t = tables[tableId];
    t.engine.newDeck();
    t.board = []; t.pot = 0; t.sidePots = []; t.phase = 'preflop';
    t.lastRaiseSize = t.bb; t.preflopBBActed = false;
    t.actionsThisRound = 0; t.roundStartIdx = -1;
    t.seats.forEach(s => { s.folded = false; s.bet = 0; s.totalBet = 0; s.cards = t.engine.dealTwo(); });

    const n = t.seats.length;
    if (n === 2) {
      const sbIdx = t.dealerIdx % n;
      const bbIdx = (t.dealerIdx + 1) % n;
      t.bbIdx = bbIdx;
      const sb = Math.min(t.sb, t.seats[sbIdx].stack);
      const bb = Math.min(t.bb, t.seats[bbIdx].stack);
      t.seats[sbIdx].stack -= sb; t.seats[sbIdx].bet = sb; t.seats[sbIdx].totalBet = sb; t.pot += sb;
      t.seats[bbIdx].stack -= bb; t.seats[bbIdx].bet = bb; t.seats[bbIdx].totalBet = bb; t.pot += bb;
      t.actIdx = sbIdx;
    } else {
      const sbIdx = (t.dealerIdx + 1) % n;
      const bbIdx = (t.dealerIdx + 2) % n;
      t.bbIdx = bbIdx;
      const sb = Math.min(t.sb, t.seats[sbIdx].stack);
      const bb = Math.min(t.bb, t.seats[bbIdx].stack);
      t.seats[sbIdx].stack -= sb; t.seats[sbIdx].bet = sb; t.seats[sbIdx].totalBet = sb; t.pot += sb;
      t.seats[bbIdx].stack -= bb; t.seats[bbIdx].bet = bb; t.seats[bbIdx].totalBet = bb; t.pot += bb;
      t.actIdx = (bbIdx + 1) % n;
    }
    console.log(`    [${tableId}] Hand — ${t.seats.map(s=>s.name).join(' vs ')} | pot=$${t.pot}`);
  },

  _nextActor(tableId) {
    const t = tables[tableId];
    let next = (t.actIdx + 1) % t.seats.length;
    let loops = 0;
    while ((t.seats[next].folded || t.seats[next].stack === 0) && loops < t.seats.length) {
      next = (next + 1) % t.seats.length;
      loops++;
    }
    t.actIdx = next;

    // Auto-fold sit-out players after 20s (matches frontend timer)
    const actor = t.seats[t.actIdx];
    if (actor && actor.sitOut && !actor.folded) {
      if (!actor._autoFoldTimer) {
        actor._autoFoldTimer = setTimeout(() => {
          actor._autoFoldTimer = null;
          if (actor.sitOut && !actor.folded && t.seats[t.actIdx] === actor) {
            this.handleAction(tableId, actor.socketId, 'fold', 0);
            if (t._onAutoFold) t._onAutoFold(tableId);
          }
        }, 20000);
      }
    }
  },

  _bettingDone(tableId) {
    const t = tables[tableId];
    const canAct = t.seats.filter(s => !s.folded && s.stack > 0);
    if (!canAct.length) return true;
    const maxBet = Math.max(0, ...t.seats.map(s => s.bet||0));
    // Everyone must have equal bets (or be all-in)
    if (!canAct.every(s => (s.bet||0) === maxBet || s.stack === 0)) return false;
    // Preflop: BB must have had option (or raised)
    if (t.phase === 'preflop' && !t.preflopBBActed) return false;
    // After a straddle (live blind raise): need full orbit PLUS straddler's option
    // actionsThisRound: raise=1, n-1 others, then straddler = n+1 total → need > n
    if (t._straddleActive) {
      if ((t.actionsThisRound||0) <= canAct.length) return false;
      return true;
    }
    // Standard betting: raise counts as 1, n-1 others must act → n total
    if ((t.actionsThisRound||0) < canAct.length) return false;
    return true;
  },

  _advancePhase(tableId) {
    const t = tables[tableId];
    t.seats.forEach(s => s.bet = 0);
    t.lastRaiseSize = t.bb;
    t.preflopBBActed = true;
    t.actionsThisRound = 0;
    t.roundStartIdx = -1;
    t._straddleActive = false; // Straddle only applies preflop

    let first = (t.dealerIdx + 1) % t.seats.length;
    let loops = 0;
    while ((t.seats[first].folded || t.seats[first].stack === 0) && loops < t.seats.length) {
      first = (first + 1) % t.seats.length; loops++;
    }
    t.actIdx = first;

    if      (t.phase === 'preflop') { t.board = t.engine.dealFlop();    t.phase = 'flop'; }
    else if (t.phase === 'flop')    { t.board.push(t.engine.dealOne()); t.phase = 'turn'; }
    else if (t.phase === 'turn')    { t.board.push(t.engine.dealOne()); t.phase = 'river'; }
    else if (t.phase === 'river')   {
      while (t.board.length < 5) t.board.push(t.engine.dealOne());
      return this._doShowdown(tableId);
    }

    console.log(`    [${tableId}] → ${t.phase} | board: ${t.board.map(c=>c.r+c.s).join(' ')} | actor: ${t.seats[t.actIdx]?.name}`);
    return null;
  },

  _resetHand(tableId) {
    const t = tables[tableId];
    t.pot = 0; t.board = []; t.sidePots = []; t.phase = 'starting'; t.actIdx = 0;
    t.lastRaiseSize = 0; t.preflopBBActed = false; t.actionsThisRound = 0; t.roundStartIdx = -1;
    t.seats.forEach(s => {
      s.bet = 0; s.totalBet = 0; s.folded = false; s.cards = [];
      if (s._autoFoldTimer) { clearTimeout(s._autoFoldTimer); s._autoFoldTimer = null; }
    });
    t.dealerIdx = (t.dealerIdx + 1) % t.seats.length;
  },
};

module.exports = { tableManager };
