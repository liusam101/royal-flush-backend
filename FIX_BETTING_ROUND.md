# Fix: Betting round ends early (folds counted as actions) — tableManager.js

## The bugs (two, intertwined — fix together, not separately)

**Bug A — fold inflation.** `_bettingDone` compares `t.actionsThisRound` (incremented on
EVERY action, including folds) against `canAct.length` (which SHRINKS when players fold).
Repro: 3 players post-flop. A checks (actions=1). B folds (actions=2). canAct is now
[A, C] = 2. actionsThisRound(2) >= 2 and all bets are equal (0), so `_bettingDone`
returns true and the next street deals — C never got to act. That is a misdeal.

**Bug B — false straddle.** In `handleAction`'s raise branch,
`isBlindRaise = t.phase === 'preflop' && (actor.bet||0) === 0` marks ANY preflop raise
by a player with no chips in front (i.e. every normal open-raise by a non-blind player)
as a "straddle", which then makes `_bettingDone` demand `actionsThisRound > canAct.length`
(one extra action). Bugs A and B partially cancel each other preflop, which is why play
has looked roughly correct. They must be fixed together.

## The fix — per-seat `acted` flags

Replace counter-based round tracking with a boolean per seat: `s.acted` = "this seat has
acted since the last full raise". This is the standard, correct implementation and it
makes the BB option fall out naturally (BB posts the blind but hasn't *acted*, so the
round can't close until they do).

### Changes in `src/tableManager.js`

**1. In `handleAction`:**

- In the `raise` branch: when the raise reopens betting, clear everyone else's flag.
  Place this next to the existing `t.lastRaiseSize` update:

  ```js
  if (newRaiseSize >= minRaise) {
    t.lastRaiseSize = newRaiseSize;
    // Full raise reopens the action — everyone else must respond again
    t.seats.forEach(s => { if (s !== actor) s.acted = false; });
  } else {
    // Short all-in: does NOT reopen action for players who already acted,
    // but players who haven't yet acted still get their turn (their flag
    // is already false). Do not clear flags here.
  }
  ```

  Remove these lines from the raise branch (superseded):
  - `t.preflopBBActed = false;`
  - `t._straddleActive = isBlindRaise;` (and the `isBlindRaise` const)
  - `t.actionsThisRound = 0; // Reset — ...`
  - `t.roundStartIdx = t.actIdx;`

- After the action branches (where `t.actionsThisRound` is currently incremented),
  replace:
  ```js
  if (t.phase === 'preflop' && t.actIdx === t.bbIdx) t.preflopBBActed = true;
  t.actionsThisRound = (t.actionsThisRound||0) + 1;
  if (t.roundStartIdx === -1) t.roundStartIdx = t.actIdx;
  ```
  with:
  ```js
  actor.acted = true;
  ```

  NOTE on short all-ins: a call or short all-in raise sets only the actor's flag. This
  changes behavior vs today (today a short all-in resets the counter and effectively
  reopens action, which is wrong poker). The new behavior — short all-in does not give
  players who already acted another turn — is the correct rule. One known limitation to
  leave as-is: this engine will still *allow* an already-acted player to re-raise if
  action somehow returns to them; enforcing call-or-fold-only after a short all-in is out
  of scope. Add a `// TODO` comment noting it.

**2. Rewrite `_bettingDone`:**

```js
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
```

Notes:
- The `s.cards?.length > 0` clause excludes seats not dealt into the current hand
  (mid-hand joiners waiting for the next hand). BEFORE adding it, verify: in `joinTable`,
  players seated during a live hand have `cards: []` until the next deal. If that's not
  how mid-hand joiners are represented, STOP and report instead of guessing.
- `preflopBBActed` and `_straddleActive` checks are gone. The BB option works because
  the BB's `acted` is false until they voluntarily act. Same for a real straddle if one
  is ever implemented (post blind → acted stays false → option preserved).
- Keep the all-in-runout check in `handleAction` (`canAct.length <= 1` after
  `_bettingDone`) unchanged, but make its canAct filter match the new one (add the
  cards-dealt clause there too).

**3. Reset points — set `acted = false` on every seat:**

- In `startHand` (where `preflopBBActed`/`actionsThisRound` are currently initialized,
  ~line 430): `t.seats.forEach(s => s.acted = false);` AFTER blinds are posted — posting
  a blind is not acting.
- In `_advancePhase` (where `s.bet = 0` is reset): add `s.acted = false` in the same
  forEach.
- In `_resetHand`: same, alongside the other per-seat resets.
- Special case already handled today at lines ~444/455 (`if BB stack === 0 →
  preflopBBActed = true`): with the new filter, an all-in BB is excluded from canAct by
  `stack > 0`, so no replacement needed. Delete those two lines.

**4. Cleanup:** remove now-dead state: `preflopBBActed`, `actionsThisRound`,
`roundStartIdx`, `_straddleActive` — from the table-object initializers (two places,
~lines 17 and 68), `startHand`, `_advancePhase`, and `_resetHand`. Grep to confirm no
other file references them (check server.js too). If anything else reads them, STOP and
report before deleting.

## What must NOT change

- Bet/raise sizing math, min-raise logic, `lastRaiseSize` behavior for short all-ins
- Pot accounting, rake, fold-win path, `_runItOut`, `_advancePhase` street progression
- `_nextActor` (verify it already skips folded/stack-0 seats; if it does not also skip
  never-dealt seats, align its skip condition with the new canAct filter)

## Acceptance tests (walk each through the code by hand, then note expected behavior)

1. **The misdeal repro:** 3 players see a flop. A checks, B folds. Expected: action moves
   to C; the turn does NOT deal until C acts. (Old code: turn dealt immediately.)
2. **BB option:** 3 players preflop, UTG calls, SB calls, BB must still get the option to
   check or raise before the flop deals. BB checks → flop deals.
3. **Raise reopens:** post-flop A bets, B calls, C raises → A and B must each act again
   before the turn deals.
4. **Heads-up preflop:** SB calls, BB checks → flop. SB folds → BB wins immediately.
5. **All-in runout:** two players all-in with equal bets → board runs out, showdown.
6. **Short all-in:** A bets 10, B raises all-in to 14 (< min-raise). C calls 14, A calls
   4 more → round closes without giving B another turn.

Run `node --check src/tableManager.js` and `node --check src/server.js`.
Commit as ONE commit: `fix: betting rounds tracked via per-seat acted flags (folds no longer close rounds early)`

## Tripwires

- If the current code around any edit point doesn't match what's described here, STOP
  and report the discrepancy.
- If `_straddleActive`, `actionsThisRound`, `roundStartIdx`, or `preflopBBActed` are
  referenced anywhere outside tableManager.js, STOP and report before removing them.
