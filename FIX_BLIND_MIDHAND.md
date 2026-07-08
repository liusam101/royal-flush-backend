# Fix: blind level-up mid-hand replaces the live deck — tableManager.js + tournamentEngine.js + sngEngine.js

## The bug

Blind increases fire on a plain `setInterval` in both `tournamentEngine._startBlindTimer`
and `sngEngine._startBlindTimer`, with no check for whether a hand is in progress. Each
tick calls `tableManager.updateBlinds`, which does:

```js
updateBlinds(tableId, sb, bb) {
  t.sb = sb; t.bb = bb;
  t.engine = new GameEngine(sb, bb);   // <-- replaces the deck mid-hand
}
```

`t.engine` owns the deck. `_advancePhase` deals the flop/turn/river from `t.engine`. If a
blind-up lands mid-hand, the remaining streets are dealt from a BRAND-NEW full 52-card
deck that still contains the cards already dealt to the board and to players' hole cards.
Result: duplicate cards on the board (e.g. a card that's also in someone's hand), which
silently produces impossible/incorrect hand evaluations.

Additionally, `tournamentEngine` replaces the engine directly
(`t.tables[tid].engine = new GameEngine(...)`) AND calls `updateBlinds` which replaces it
again — a redundant double-replace. (The `t.tables[tid]` engine is the tournamentEngine's
own bookkeeping copy; the one that actually deals is the `tableManager` table's engine.)

## The fix — defer blind changes until the hand ends; never swap the deck mid-hand

Two parts: (1) `updateBlinds` must NOT replace the engine, and must not apply mid-hand;
(2) apply any pending blind change at hand start.

### Change 1 — `tableManager.updateBlinds` (tableManager.js)

Do not create a new GameEngine. Blinds are read from `t.sb`/`t.bb` at hand start
(`_startHand` uses `t.sb`, `t.bb` for posting). The engine does not need to be recreated
to change blind sizes — verify GameEngine only uses sb/bb for its constructor and doesn't
gate dealing on them (from the code, the deck logic is independent of blind values). If
that's true, the engine never needs replacing for a blind change at all.

Replace with a deferred-apply model:

```js
updateBlinds(tableId, sb, bb) {
  const t = tables[tableId];
  if (!t) return;
  const inProgress = t.phase !== 'waiting' && t.phase !== 'starting';
  if (inProgress) {
    // Don't change blinds mid-hand — stash and apply at next hand start.
    t.pendingBlinds = { sb, bb };
  } else {
    t.sb = sb; t.bb = bb;
    t.pendingBlinds = null;
  }
}
```

Do NOT touch `t.engine` at all. If verification shows GameEngine genuinely needs its
sb/bb refreshed for some reason (check `newDeck`/`dealTwo`/`dealFlop`/`dealOne` — they
should be pure deck ops), report it before proceeding; otherwise leave the engine alone.

### Change 2 — apply pending blinds at hand start (tableManager.js)

In `_startHand`, at the very top (before posting blinds), apply any pending change:

```js
_startHand(tableId) {
  const t = tables[tableId];
  if (t.pendingBlinds) {
    t.sb = t.pendingBlinds.sb;
    t.bb = t.pendingBlinds.bb;
    t.pendingBlinds = null;
  }
  t.engine.newDeck();   // existing line — reshuffles for the new hand
  ...
}
```

Confirm `_startHand` already calls `t.engine.newDeck()` (it does per earlier reads) — that
is the correct, only place a fresh deck should appear. The existing engine instance is
reused; `newDeck()` reshuffles it properly.

### Change 3 — `tournamentEngine._startBlindTimer` (tournamentEngine.js)

Remove the direct engine replacement; let `updateBlinds` handle it (now deferred). Change:

```js
Object.keys(t.tables).forEach(tid => {
  t.tables[tid].engine = new GameEngine(sb, bb);   // DELETE this line
  tableManager.updateBlinds(tid, sb, bb);
});
```
to:
```js
Object.keys(t.tables).forEach(tid => {
  tableManager.updateBlinds(tid, sb, bb);
});
```

If `t.tables[tid].engine` is read anywhere else in tournamentEngine for actual dealing
(not just construction), STOP and report — it should only be the tableManager engine that
deals. Grep `t.tables[tid].engine` and `.engine` in tournamentEngine.js to confirm it's
inert bookkeeping before deleting.

### Change 4 — `sngEngine._startBlindTimer` (sngEngine.js)

Already only calls `tableManager.updateBlinds(sng.tableId, ...)` — no direct engine swap.
No change needed beyond what Change 1 provides. Confirm and note it.

## Acceptance tests (hand-trace each)

1. **Blind timer fires mid-hand (preflop/flop/turn):** current hand completes on its
   ORIGINAL deck with no duplicate cards; blinds unchanged for the current hand.
2. **Next hand after a mid-hand blind tick:** starts with the new blind level; SB/BB
   posted at new amounts; deck reshuffled normally via `newDeck()`.
3. **Blind timer fires between hands (phase waiting/starting):** applies immediately, next
   hand uses new blinds.
4. **Multiple blind ticks during one very long hand:** only the LATEST pending level
   applies at next hand start (later tick overwrites `pendingBlinds`). Verify no stacking.
5. **Deck integrity:** after a mid-hand blind tick, deal the hand to showdown and confirm
   all 5 board cards + all hole cards are unique (no card appears twice).

## Must NOT change

- Deck/RNG logic in gameEngine.js or rng.js.
- Blind timer intervals / level schedules (STD_BLINDS, SNG_BLINDS).
- Chip/pot/rake logic.
- The tournament's own `t.blindLevel` tracking.

`node --check src/tableManager.js src/tournamentEngine.js src/sngEngine.js`.
Commit as ONE commit: `fix: defer blind changes to next hand; never replace live deck mid-hand`

## Tripwires

- If GameEngine's dealing methods depend on sb/bb (they shouldn't), report before changing
  updateBlinds.
- If `t.tables[tid].engine` is used for real dealing in tournamentEngine, report before
  deleting the direct replacement.
- If any code reads `t.sb`/`t.bb` expecting the mid-hand value to have already changed
  (i.e. something relies on the old buggy immediate update), report it.
- Any mismatch with the descriptions above → STOP and report.
