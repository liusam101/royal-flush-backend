# Fix: disconnected player treated as live at showdown — tableManager.js

## Context — the intended design (do NOT break this)

The disconnect flow is deliberate and mostly correct:
- On disconnect, `markDisconnected` marks the seat `sitOut=true, disconnected=true`.
- If it's the player's turn, they're folded immediately so the hand continues.
- The seat is KEPT for 60s so a network blip lets them reconnect (`reconnectPlayer`) into
  the same seat with the same cards.
- After 60s with no reconnect, `removePlayer` → `leaveTable` removes them and reconciles
  chips.

This grace-period design is good and must be preserved. The fix below must NOT remove the
seat early or shorten the reconnect window.

## The bug

When a player disconnects mid-hand and it is **NOT their turn**, `markDisconnected` sets
`sitOut`/`disconnected` but leaves them `folded = false` with their `cards` intact. If the
hand then reaches showdown before their 60s window expires, `_doShowdown` treats them as a
live contender:

```js
const active = t.seats.filter(s => !s.folded && s.cards && s.cards.length >= 2);
```

A disconnected player with no ability to act still has cards and `folded=false`, so they
are dealt into the showdown and can WIN a pot they were never present to contest. Their
winnings land in their seat stack and get reconciled to their DB balance on reconnect or
removal — so a disconnected player can win money passively. Worse, if they win and then
never reconnect, the 60s-removal reconciliation banks it.

There is a genuine poker-fairness question here (a disconnected player who is all-in
SHOULD still win — they have no action left to take), so the fix must distinguish two
cases:

- **Disconnected but all-in (stack === 0):** they have no further action anyway. They
  SHOULD remain live at showdown. This is standard poker (an all-in player can't act).
  Leave them in.
- **Disconnected with chips behind (stack > 0):** they still had decisions to make and
  simply aren't present. When action reaches them they'll be auto-folded by the sit-out
  timer — but if the hand reaches showdown via other players before that timer fires, or
  in an all-in runout, they're wrongly included. These players should be folded when they
  can no longer meaningfully continue.

## The fix

The cleanest correct behavior: a disconnected player with chips behind is auto-folded the
moment action would require them OR the betting round completes without them having
matched the current bet. The existing sit-out auto-fold timer handles the "action reaches
them" case. The gap is showdown/runout reaching them first.

Add a guard in the showdown eligibility and in `_bettingDone`/runout so a disconnected
player with chips behind who has NOT matched the current bet is treated as folded.

### Change 1 — `markDisconnected` (tableManager.js)

No change to the turn-fold logic. Leave as-is.

### Change 2 — `_doShowdown` eligibility (tableManager.js)

Where `active` is computed (both the top-level `active` and the per-side-pot `eligible`
filters), exclude disconnected players who did not match the final bet. Since by showdown
all live players have equal bets, the correct check is: a `disconnected` player is only
eligible if they contributed up to the pot level they're being considered for. The
simplest safe rule that preserves all-in fairness:

```js
// A disconnected player stays eligible ONLY if they're all-in (stack === 0).
// Disconnected with chips behind = folded for showdown purposes.
const isEligible = (s) =>
  !s.folded && s.cards && s.cards.length >= 2 &&
  !(s.disconnected && s.stack > 0);
```

Apply `isEligible` in place of the inline `!s.folded && s.cards?.length >= 2` in:
- the top-level `active` filter in `_doShowdown`
- the `eligible` filter inside the side-pot loop
- the `active` filter in `_runItOut`'s call into `_doShowdown` (verify path)

Do NOT change `calcSidePots` contribution math — a disconnected-with-chips player who put
money in earlier streets still has that money in the pot (correct); they simply can't WIN
it. Their contributed chips stay in the pot for the remaining eligible players. Confirm by
trace: their `totalBet` still counts toward pot size, they're just not in any `eligible`
list.

### Change 3 — guard the all-in runout trigger (tableManager.js)

In `handleAction`, the runout fires when `_bettingDone` is true and
`canAct.length <= 1`. `canAct` already filters `stack > 0`, so an all-in disconnected
player doesn't inflate it. But verify: if a disconnected-with-chips player is the reason
`_bettingDone` is NOT yet true (they haven't acted), the sit-out auto-fold timer must
still be running to eventually fold them. Confirm `_nextActor` set their `_autoFoldTimer`
when action passed to them. If action never reaches them because everyone else finished,
`_bettingDone` requires them to have `acted` — they haven't — so the round correctly
stalls until their auto-fold timer fires. Trace this and confirm no deadlock: the timer
MUST fire. If there's a path where a disconnected-with-chips player can stall a round with
no timer set, report it.

## Acceptance tests (hand-trace each)

1. **Disconnect not on turn, hand goes to showdown, player had chips behind:** they are
   excluded from showdown; pot awarded among present players; their earlier contributions
   remain in the pot. They cannot win.
2. **Disconnect while all-in, hand runs out:** they REMAIN eligible and can win their
   entitled (side) pot — correct poker.
3. **Disconnect not on turn, then reconnect within 60s before showdown:** they're restored
   to fully live (`disconnected=false` via `reconnectPlayer`) and play normally.
4. **Disconnect on turn:** folded immediately (unchanged behavior).
5. **Everyone else finishes the round while a disconnected-with-chips player hasn't
   acted:** round stalls, their sit-out auto-fold timer fires, they fold, hand proceeds.
   No deadlock, no premature showdown including them.

## Must NOT change

- The 60s reconnect grace period or `reconnectPlayer`.
- `calcSidePots` contribution math.
- `markDisconnected`'s immediate-fold-on-turn behavior.
- Chip reconciliation in the disconnect timeout / removePlayer path.

`node --check src/tableManager.js && node --check src/server.js`.
Commit as ONE commit: `fix: disconnected player with chips behind excluded from showdown (all-in still eligible)`

## Tripwires

- If excluding a disconnected-with-chips player from `eligible` would ever make a side pot
  have zero eligible winners (e.g. everyone remaining is disconnected-with-chips), that
  pot's chips must not vanish — report this case and how the current side-pot loop handles
  an empty `eligible` (it currently `continue`s, which could strand chips). Flag it; do not
  improvise a fix in this commit.
- If any current behavior differs from what's described, STOP and report.
