# Fix: mid-hand leave corrupts side pots and returns forfeited chips — tableManager.js + server.js

## The bugs (three, all rooted in deleting a seat mid-hand)

The current `leaveTable` removes the leaver's seat from `t.seats` immediately, mid-hand,
whenever 2+ players remain. That causes:

**Bug A — the leaver's contribution vanishes from side-pot math.** `calcSidePots` sums
`s.totalBet` across `t.seats`. When the seat is spliced out, that player's `totalBet`
(chips already in the pot) disappears from the calculation, but `t.pot` still holds the
money. At showdown the side pots no longer sum to `t.pot` → chips are created or
destroyed in any multi-way / all-in hand a player left.

**Bug B — array re-index shifts whose turn it is.** After the filter,
`t.seats.forEach((s,i) => s.seat = i)` renumbers everyone, and `t.actIdx` is only
bounds-checked (`>= length → 0`), not corrected. If someone earlier in the array leaves,
every later seat shifts down one index and `t.actIdx` now points at the WRONG player.

**Bug C — the leaver keeps their forfeited pot money.** `returnedStack = leaving.stack`
returns only the chips in front of them — correct. But the money they already put in the
pot (`totalBet`) has been forfeited to whoever wins the hand. That part is fine. The
problem: because the seat is deleted, if the hand later ends via normal showdown, the
leaver isn't in `t.seats`, so `settleHandChips` never reconciles them — their
`socket.chips` is set from `returnedStack` in the server handler, which is right, BUT the
pot they forfeited to is now mis-sized because of Bug A. The three interact.

## The fix — do not delete the seat mid-hand

Mark the leaver as folded and flagged "left", settle their returned stack, but keep the
seat in `t.seats` (with its `totalBet` intact) until the hand ends. Physically remove
left-flagged seats only in `_resetHand`, after settlement.

### Changes in `src/tableManager.js`

**1. Rewrite `leaveTable`:**

```js
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
        foldRake = Math.min(Math.round(t.pot * 0.025 * 100) / 100, 3.00);
        t._rakeCollected = (t._rakeCollected || 0) + foldRake;
      }
      remaining[0].stack += (t.pot - foldRake);
      handResult = { winner: remaining[0].name, amount: t.pot - foldRake, rake: foldRake, reason: 'opponent left' };
      this._resetHand(tableId);   // _resetHand will physically drop the left seat
    } else if (t.actIdx >= 0 && t.seats[t.actIdx] === leaving) {
      // It was the leaver's turn — advance action to the next eligible player.
      this._nextActor(tableId);
      // If that closed the round, the caller's next handleAction cycle handles it;
      // but leaving is not an "action", so also check if betting is now done:
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
```

**2. In `_resetHand`:** physically remove any seats flagged `left` (they stayed in only
for pot math). Add at the START of `_resetHand`, before the per-seat resets:

```js
if (t.seats.some(s => s.left)) {
  t.seats = t.seats.filter(s => !s.left);
  t.seats.forEach((s, i) => { s.seat = i; });
  if (t.dealerIdx >= t.seats.length) t.dealerIdx = 0;
  if (t.actIdx    >= t.seats.length) t.actIdx    = 0;
}
```
Then, if `t.seats.length < 2`, set `t.phase = 'waiting'` at the end of `_resetHand`
(verify whether _resetHand or the caller currently handles the drop-below-2 case; if the
caller does, leave it — just make sure a table that empties to <2 after removing left
seats ends up in 'waiting').

**3. Verify `_nextActor` skips left seats.** It currently skips
`folded || stack === 0 || !cards?.length`. A left seat is `folded = true`, so it's
already skipped. No change needed — but confirm.

**4. Verify `calcSidePots` now includes the leaver correctly.** The leaver stays in
`t.seats` with `folded = true` and their original `totalBet`. `calcSidePots` already adds
folded players' contributions (the `foldedContrib` block). Confirm the leaver's forfeited
chips flow into the pot via that path — trace one example by hand and note it.

### Changes in `src/server.js`

The `leaveTable` socket handler mostly still works, but verify:

- `returnedStack` is the off-table return — unchanged, correct.
- When `handResult` is present, `settleHandChips(tableId, hr, 'leave')` runs. Now that the
  winner's stack was already credited inside `leaveTable` (the `remaining[0].stack += pot`
  line), confirm `settleHandChips` reconciles the winner's DB balance from their seat
  stack delta and does NOT double-credit. Trace this: `settleHandChips` computes
  `delta = (offTableChips + seat.stack) - skt.chips`, so it writes the difference, not the
  pot again. Should be safe — but confirm the winner is still seated at settlement time
  (they are; only `left` seats get dropped, and the winner didn't leave).
- The leaver's own DB reconciliation happens in the handler's `if (socket.userId)` block
  via `returnedStack`. Confirm this still fires for the leaver (it runs regardless of
  handResult). Good.

## Acceptance tests (hand-trace each, then note expected result)

1. **3-way, one leaves mid-hand, other two go to showdown.** Pot must equal sum of both
   remaining players' contributions PLUS the leaver's forfeited totalBet. No chips
   created/destroyed. (Old code: leaver's contribution vanished → pot short.)
2. **Leaver was the current actor.** Action advances to the correct next player; the
   player who was "next" before the leave is still next (no index shift skipping someone).
3. **Leave reduces table to 1 non-folded player.** That player wins pot minus fold-rake
   immediately; hand ends; left seat is gone by next hand.
4. **All-in side pot where the all-in player then leaves before showdown.** Their
   totalBet stays in the correct side pot; eligibility unchanged; side pots sum to t.pot.
5. **Leave while NOT in a hand (waiting/starting).** Seat removed immediately as before;
   table drops to 'waiting' if <2 remain.
6. **Two leave in the same hand.** Both marked left, both dropped at hand end, pot math
   still balances.

## Must NOT change

- `calcSidePots` logic, rake math, showdown/eligibility, `_advancePhase`.
- The server handler's chip-return math for the leaver (`returnedStack` path).

`node --check src/tableManager.js && node --check src/server.js`.
Commit as ONE commit: `fix: keep leaver seat in pot math until hand ends (side pots + turn order)`

## Tripwires

- If `_resetHand` already handles the <2-players → waiting transition differently than
  described, adapt to the existing structure and note what you did — do NOT duplicate it.
- If any other code path deletes seats mid-hand (search for `t.seats = t.seats.filter`
  and `.splice(` across src/), report it — the disconnect path may need the same fix and
  should be flagged, not silently changed in this commit.
- If current code doesn't match this description at any edit point, STOP and report.
