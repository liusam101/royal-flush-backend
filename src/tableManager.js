const { GameEngine, bestFive, compareScore } = require('./gameEngine');
const { roundMoney } = require('./money');

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
    lastRaiseSize: 0, bbIdx: 0,
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


const tableManager = {

  // Register auto-fold callback
  onAutoFold(tableId, cb) {
    if (tables[tableId]) tables[tableId]._onAutoFold = cb;
  },

  // Create a new dynamic table (for SNGs/tournaments)
  createTable(tableId, { name, sb, bb, ante=0, maxSeats, isTournament=false }) {
    if (tables[tableId]) return; // already exists
    tables[tableId] = {
      id: tableId, name, sb, bb, ante, maxSeats,
      seats: [], engine: new GameEngine(sb, bb),
      phase: 'waiting', pot: 0, sidePots: [], board: [],
      actIdx: 0, dealerIdx: 0, isTournament,
      lastRaiseSize: 0, bbIdx: 0,
    };
  },

  // Update blinds (and optional ante) for tournament blind levels.
  updateBlinds(tableId, sb, bb, ante = 0) {
    const t = tables[tableId];
    if (!t) return;
    const inProgress = t.phase !== 'waiting' && t.phase !== 'starting';
    if (inProgress) {
      t.pendingBlinds = { sb, bb, ante };
    } else {
      t.sb = sb; t.bb = bb; t.ante = ante;
      t.pendingBlinds = null;
    }
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
      sb: t.sb, bb: t.bb, ante: t.ante || 0, maxSeats: t.maxSeats,
      board: t.board, sidePots: t.sidePots || [],
      seats: t.seats.map((s, i) => ({
        seat:     s.seat,
        socketId: s.socketId,
        name:     s.name,
        stack:    s.stack,
        bet:      s.bet || 0,
        folded:   !!s.folded,
        allIn:    s.stack === 0 && !s.folded,
        acting:   inProgress && i === t.actIdx && !s.folded,
        isDealer: i === t.dealerIdx,
        sitOut:   !!s.sitOut,
        disconnected: !!s.disconnected,
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
    const midHand = t.phase !== 'waiting' && t.phase !== 'starting';
    t.seats.push({ socketId, name: playerName, stack: buyIn, seat: seatIdx, bet: 0, totalBet: 0, folded: false, cards: [], sitOut: midHand, pendingActive: midHand });

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

    const leaving = t.seats.find(s => s.socketId === socketId);
    if (!leaving) return { stack: 0, handResult: null };
    if (leaving._autoFoldTimer) { clearTimeout(leaving._autoFoldTimer); leaving._autoFoldTimer = null; }

    const returnedStack = leaving.stack || 0;
    const inProgress = t.phase !== 'waiting' && t.phase !== 'starting';

    if (inProgress) {
      // Keep the seat (and its totalBet) in the pot math until the hand ends.
      // Mark folded + left; take their remaining stack off the table now.
      leaving.folded = true;
      leaving.left = true;
      leaving.stack = 0;
      leaving.sitOut = true;
      if (leaving._autoFoldTimer) { clearTimeout(leaving._autoFoldTimer); leaving._autoFoldTimer = null; }

      // If only one non-folded player now remains, award the pot immediately.
      const remaining = t.seats.filter(s => !s.folded);
      let handResult = null;
      if (remaining.length === 1 && t.pot > 0) {
        let foldRake = 0;
        if (!t.isTournament && t.pot >= 1) {
          foldRake = Math.min(roundMoney(t.pot * 0.025), 3.00);
          t._rakeCollected = (t._rakeCollected || 0) + foldRake;
        }
        remaining[0].stack += (t.pot - foldRake);
        // Rabbit hunt: deal what the rest of the board would have been (deck state is fresh anyway on next hand).
        const rabbitBoard = [];
        const need = 5 - (t.board?.length || 0);
        for (let i = 0; i < need; i++) rabbitBoard.push(t.engine.dealOne());
        handResult = { winner: remaining[0].name, amount: t.pot - foldRake, rake: foldRake, reason: 'opponent left', rabbitBoard };
        this._resetHand(tableId);   // _resetHand will physically drop the left seat
      } else if (t.actIdx >= 0 && t.seats[t.actIdx] === leaving) {
        // It was the leaver's turn — advance action to the next eligible player.
        this._nextActor(tableId);
        // leaving is not an "action", so check if betting is now done:
        if (this._bettingDone(tableId)) {
          const over = this._advancePhase(tableId);
          if (over) { handResult = over; this._resetHand(tableId); }
        }
      }
      return { stack: returnedStack, handResult };
    }

    // Not in a hand — safe to remove the seat immediately.
    t.seats = t.seats.filter(s => s.socketId !== socketId);
    t.seats.forEach((s, i) => { s.seat = i; });
    if (t.seats.length < 2) {
      t.phase = 'waiting'; t.pot = 0; t.board = []; t.sidePots = [];
      t.seats.forEach(s => { s.bet = 0; s.totalBet = 0; s.folded = false; s.cards = []; s.acted = false; });
    }
    if (t.actIdx    >= t.seats.length) t.actIdx    = 0;
    if (t.dealerIdx >= t.seats.length) t.dealerIdx = 0;
    return { stack: returnedStack, handResult: null };
  },

  removePlayer(socketId) {
    const affected = [];
    let totalStack = 0;
    Object.keys(tables).forEach(tid => {
      if (tables[tid].seats.find(s => s.socketId === socketId)) {
        const result = this.leaveTable(tid, socketId);
        totalStack += result?.stack || 0;
        affected.push(tid);
      }
    });
    return { affected, stack: totalStack };
  },

  setSitOut(tableId, socketId, sitOut) {
    const t = tables[tableId];
    if (!t) return;
    const seat = t.seats.find(s => s.socketId === socketId);
    if (seat) seat.sitOut = sitOut;
  },

  // Mark as sitting out + disconnected without removing from the table.
  // If it's their turn right now, fold immediately so the hand continues.
  // Returns { affected: [tableId,...], handResults: [{ tableId, handResult },…] }
  // so the caller can emit handResult events for any hands that just ended.
  markDisconnected(socketId) {
    const affected    = [];
    const handResults = [];
    Object.keys(tables).forEach(tid => {
      const t = tables[tid];
      const seatIdx = t.seats.findIndex(s => s.socketId === socketId);
      if (seatIdx === -1) return;
      const seat = t.seats[seatIdx];
      seat.sitOut      = true;
      seat.disconnected = true;
      if (!seat.folded && seatIdx === t.actIdx &&
          t.phase !== 'waiting' && t.phase !== 'starting') {
        if (seat._autoFoldTimer) { clearTimeout(seat._autoFoldTimer); seat._autoFoldTimer = null; }
        const result = this.handleAction(tid, socketId, 'fold', 0);
        if (result?.handOver && result?.handResult) {
          handResults.push({ tableId: tid, handResult: result.handResult });
        }
      }
      affected.push(tid);
    });
    return { affected, handResults };
  },

  // Re-attach a reconnecting player's new socket to their existing seat.
  reconnectPlayer(tableId, oldSocketId, newSocketId) {
    const t = tables[tableId];
    if (!t) return null;
    const seat = t.seats.find(s => s.socketId === oldSocketId && s.disconnected);
    if (!seat) return null;
    seat.socketId = newSocketId;
    seat.sitOut = false;
    seat.disconnected = false;
    return { seat: seat.seat, cards: seat.cards || [] };
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
      const minRaise  = Math.max(t.bb, t.lastRaiseSize || t.bb);
      const minTotal  = maxBet + minRaise;
      const reqTotal  = Math.max(minTotal, Number(amount) || minTotal);
      const total     = Math.min(reqTotal, actor.stack + (actor.bet||0));
      // Only update lastRaiseSize for full raises — a short all-in doesn't reopen betting
      const newRaiseSize = total - maxBet;
      if (newRaiseSize >= minRaise) {
        t.lastRaiseSize = newRaiseSize;
        // Full raise reopens the action — everyone else must respond again
        t.seats.forEach(s => { if (s !== actor) s.acted = false; });
      } else {
        // Short all-in: does NOT reopen action for players who already acted,
        // but players who haven't yet acted still get their turn (their flag
        // is already false). Do not clear flags here.
      }
      const extra     = total - (actor.bet||0);
      actor.stack    -= Math.max(0, extra);
      actor.totalBet  = (actor.totalBet||0) + Math.max(0, extra);
      actor.bet       = total;
      t.pot          += Math.max(0, extra);
    }

    // TODO: a short all-in does not give players who already acted another turn.
    // Enforcing call-or-fold-only after a short all-in is out of scope.
    actor.acted = true;

    // Only one active player left → wins immediately
    const active = t.seats.filter(s => !s.folded);
    if (active.length === 1) {
      // Rake on fold wins too (but only if pot is big enough)
      let foldRake = 0;
      if (!t.isTournament && t.pot >= 1) {
        foldRake = Math.min(roundMoney(t.pot * 0.025), 3.00);
        t._rakeCollected = (t._rakeCollected || 0) + foldRake;
      }
      active[0].stack += (t.pot - foldRake);
      // Rabbit hunt: capture the would-be remaining board for the client's optional reveal.
      const rabbitBoard = [];
      const need = 5 - (t.board?.length || 0);
      for (let i = 0; i < need; i++) rabbitBoard.push(t.engine.dealOne());
      const handResult = { winner: active[0].name, amount: t.pot - foldRake, rake: foldRake, reason: 'others folded', rabbitBoard };
      this._resetHand(tableId);
      return { ok: true, handOver: true, handResult };
    }

    this._nextActor(tableId);

    if (this._bettingDone(tableId)) {
      // All-in runout — everyone remaining is all-in
      const canAct = t.seats.filter(s => !s.folded && s.stack > 0 && s.cards?.length > 0);
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
      // Simple case — single pot (handles ties with equal split)
      const result = t.engine.showdown(active, t.board);
      // ── Rake: 2.5% of pot, capped at $3 (exempt: tournaments, pots < $1)
      let rake = 0;
      if (!t.isTournament && totalPot >= 1) {
        rake = Math.min(roundMoney(totalPot * 0.025), 3.00);
        t._rakeCollected = (t._rakeCollected || 0) + rake;
      }
      const net = totalPot - rake;
      const winSeats = (result.winners || [result.winner])
        .map(n => active.find(s => s.name === n)).filter(Boolean);
      const share = Math.floor(net / winSeats.length * 100) / 100;
      winSeats.forEach(w => w.stack += share);
      // Rounding remainder (pennies) goes to the first winner
      const remainder = roundMoney(net - share * winSeats.length);
      if (remainder > 0 && winSeats[0]) winSeats[0].stack += remainder;
      const showCards = active.map(s => ({ name: s.name, cards: s.cards }));
      const handResult = { winner: result.winner, winners: result.winners, hand: result.hand, amount: net, rake, board: t.board, showCards };
      this._resetHand(tableId);
      return handResult;
    }

    // Multiple side pots (each pot split among tied winners at that level)
    let lastWinner = null, lastHand = null, lastAmount = 0;
    for (const sp of sidePots) {
      const eligible = sp.eligible.map(i => t.seats[i]).filter(s => !s.folded && s.cards && s.cards.length >= 2);
      if (!eligible.length) continue;
      const result = t.engine.showdown(eligible, t.board);
      const winSeats = (result.winners || [result.winner])
        .map(n => eligible.find(s => s.name === n)).filter(Boolean);
      const share = Math.floor(sp.amount / winSeats.length * 100) / 100;
      winSeats.forEach(w => w.stack += share);
      const remainder = roundMoney(sp.amount - share * winSeats.length);
      if (remainder > 0 && winSeats[0]) winSeats[0].stack += remainder;
      lastWinner = result.winner;
      lastHand   = result.hand;
      lastAmount += sp.amount;
      allResults.push({ winner: result.winner, winners: result.winners, hand: result.hand, amount: sp.amount });
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
    if (t.pendingBlinds) {
      t.sb = t.pendingBlinds.sb;
      t.bb = t.pendingBlinds.bb;
      if (t.pendingBlinds.ante != null) t.ante = t.pendingBlinds.ante;
      t.pendingBlinds = null;
    }
    t.engine.newDeck();
    t.board = []; t.pot = 0; t.sidePots = []; t.phase = 'preflop';
    t.lastRaiseSize = t.bb;
    t.seats.forEach(s => { s.folded = false; s.bet = 0; s.totalBet = 0; s.cards = t.engine.dealTwo(); });

    const n = t.seats.length;
    let sbIdx, bbIdx;
    if (n === 2) {
      sbIdx = t.dealerIdx % n;
      bbIdx = (t.dealerIdx + 1) % n;
      t.bbIdx = bbIdx;
      const sb = Math.min(t.sb, t.seats[sbIdx].stack);
      const bb = Math.min(t.bb, t.seats[bbIdx].stack);
      t.seats[sbIdx].stack -= sb; t.seats[sbIdx].bet = sb; t.seats[sbIdx].totalBet = sb; t.pot += sb;
      t.seats[bbIdx].stack -= bb; t.seats[bbIdx].bet = bb; t.seats[bbIdx].totalBet = bb; t.pot += bb;
      t.actIdx = sbIdx;
    } else {
      sbIdx = (t.dealerIdx + 1) % n;
      bbIdx = (t.dealerIdx + 2) % n;
      t.bbIdx = bbIdx;
      const sb = Math.min(t.sb, t.seats[sbIdx].stack);
      const bb = Math.min(t.bb, t.seats[bbIdx].stack);
      t.seats[sbIdx].stack -= sb; t.seats[sbIdx].bet = sb; t.seats[sbIdx].totalBet = sb; t.pot += sb;
      t.seats[bbIdx].stack -= bb; t.seats[bbIdx].bet = bb; t.seats[bbIdx].totalBet = bb; t.pot += bb;
      t.actIdx = (bbIdx + 1) % n;
    }
    // Big-blind ante: only BB posts the ante on top of the big blind. Goes directly to the pot,
    // does NOT count toward the BB's bet-to-call amount (so preflop action still resolves normally).
    if (t.ante && t.ante > 0) {
      const bbSeat = t.seats[bbIdx];
      const anteAmt = Math.min(t.ante, bbSeat.stack);
      bbSeat.stack -= anteAmt;
      bbSeat.totalBet += anteAmt;
      t.pot += anteAmt;
    }
    // Posting a blind is not acting — reset after blinds so BB retains their option
    t.seats.forEach(s => s.acted = false);
    console.log(`    [${tableId}] Hand — ${t.seats.map(s=>s.name).join(' vs ')} | pot=$${t.pot}${t.ante?' (ante '+t.ante+')':''}`);
  },

  _nextActor(tableId) {
    const t = tables[tableId];
    let next = (t.actIdx + 1) % t.seats.length;
    let loops = 0;
    while ((t.seats[next].folded || t.seats[next].stack === 0 || !(t.seats[next].cards?.length)) && loops < t.seats.length) {
      next = (next + 1) % t.seats.length;
      loops++;
    }
    t.actIdx = next;

    // Auto-fold sit-out players. Standard = 20s; during bubble hand-for-hand the
    // tournament layer sets t._fastAutoFoldMs = 5000 so the bubble breaks faster.
    const actor = t.seats[t.actIdx];
    if (actor && actor.sitOut && !actor.folded) {
      if (!actor._autoFoldTimer) {
        const delay = (t._fastAutoFoldMs && t._fastAutoFoldMs > 0) ? t._fastAutoFoldMs : 20000;
        actor._autoFoldTimer = setTimeout(() => {
          actor._autoFoldTimer = null;
          if (actor.sitOut && !actor.folded && t.seats[t.actIdx] === actor) {
            const result = this.handleAction(tableId, actor.socketId, 'fold', 0);
            if (t._onAutoFold) t._onAutoFold(tableId, result);
          }
        }, delay);
      }
    }
  },

  // Server layer calls this to switch a tournament table's auto-fold delay (e.g. bubble mode).
  setAutoFoldDelay(tableId, ms) {
    const t = tables[tableId];
    if (!t) return;
    t._fastAutoFoldMs = ms;
  },

  _bettingDone(tableId) {
    const t = tables[tableId];
    const canAct = t.seats.filter(s => !s.folded && s.stack > 0 && (s.cards?.length > 0));
    if (!canAct.length) return true;
    const maxBet = Math.max(0, ...t.seats.map(s => s.bet||0));
    // Everyone still able to act must have matched the bet AND acted since the last raise
    if (!canAct.every(s => (s.bet||0) === maxBet)) return false;
    if (!canAct.every(s => s.acted)) return false;
    return true;
  },

  _advancePhase(tableId) {
    const t = tables[tableId];
    t.seats.forEach(s => { s.bet = 0; s.acted = false; });
    t.lastRaiseSize = t.bb;

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
    if (t.seats.some(s => s.left)) {
      t.seats = t.seats.filter(s => !s.left);
      t.seats.forEach((s, i) => { s.seat = i; });
      if (t.dealerIdx >= t.seats.length) t.dealerIdx = 0;
      if (t.actIdx    >= t.seats.length) t.actIdx    = 0;
    }
    t.pot = 0; t.board = []; t.sidePots = []; t.phase = 'starting'; t.actIdx = 0;
    t.lastRaiseSize = 0;
    t.seats.forEach(s => {
      s.bet = 0; s.totalBet = 0; s.folded = false; s.cards = []; s.acted = false;
      if (s._autoFoldTimer) { clearTimeout(s._autoFoldTimer); s._autoFoldTimer = null; }
      if (s.pendingActive) { s.sitOut = false; s.pendingActive = false; }
    });
    if (t.seats.length < 2) t.phase = 'waiting';
    else t.dealerIdx = (t.dealerIdx + 1) % t.seats.length;
  },
};

module.exports = { tableManager };
