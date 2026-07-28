# Anti-Cheat Refactor #4b — Plumb per-hand betting sequences into the detector (+ fix dead VPIP wiring)

## Purpose

Real collusion detection (soft-play, whipsaw) needs the per-street BETTING SEQUENCE of each
hand — who bet/raised/checked/called into whom, per street. That data already exists in
`handHistory` (`recordAction` logs `{ts, player, action, amount, pot, phase}` per action), but
it is NEVER passed to the anti-cheat layer — `onHandResult` only gets winner/loser/amount.

This refactor is PLUMBING ONLY. It:
1. Adds a new `antiCheat.onHandComplete(tableId, record)` hook that receives the full hand
   record (including the `actions` array), called on EVERY hand at EVERY endHand site.
2. Fixes the dead `isFirstAction`/VPIP wiring that refactor #4a surfaced.

It adds NO collusion detection logic (that's #4c and #4d). The hook should store/accumulate
the minimum needed and otherwise be a no-op stub ready for the detectors to build on.

Depends on #1–#4a (done).

## Part 1 — onHandComplete hook

### server.js — capture endHand's return and pass it

There are FOUR `handHistory.endHand(...)` call sites (~373, ~817, ~1485, ~1570). Currently
their return value is discarded. At EACH site, capture it and pass to the new hook:

```js
const _rec = handHistory.endHand(tableId, hr);   // (use tid at the 1570 site)
if (_rec) antiCheat.onHandComplete(tableId, _rec);
```

Rationale for all four (not just the showdown path at 817): soft-play frequently ends WITHOUT
showdown (partners check it down, or one folds to avoid betting into the other). The detector
must see fold-terminated hands too. `onHandResult` stays where it is (showdown-only, for
chip-dump/win-loss) — `onHandComplete` is the new, every-hand hook.

Confirm each site's variable name for the result object (`hr` vs `tid`) and match locally.

### antiCheat.js — the hook (stub + minimal accumulation)

Add:

```js
// Called once per completed hand with the FULL hand record from handHistory,
// including record.actions[] = [{ts, player, action, amount, pot, phase}, ...].
// Detectors in #4c/#4d read from this. For now: resolve player names -> userIds,
// store a compact recent-hands buffer per table for pairing analysis, no detection yet.
antiCheat.onHandComplete = (tableId, record) => {
  if (!record || !Array.isArray(record.actions)) return;

  // Map seat display names in this hand to userIds via live sockets at the table.
  // record.actions uses `player` = display name. Build a name->userId map from the
  // current table seats (best-effort; a player who left mid-hand may be unresolved).
  const nameToUser = _resolveTableNames(tableId);

  // Keep a bounded per-table ring of recent completed hands for multi-hand pairing
  // analysis (used by #4d). Store only what detectors need, not whole records.
  const slim = {
    handId: record.handId,
    ts: record.endTs || Date.now(),
    winner: record.winner,
    amount: record.amount || 0,
    reason: record.reason,
    showdown: (record.reason === 'showdown'),
    actions: record.actions.map(a => ({
      user: nameToUser[a.player] || null,
      name: a.player,
      action: a.action,
      amount: a.amount || 0,
      phase: a.phase,
    })),
    seats: Object.values(nameToUser), // userIds present this hand
  };

  if (!recentHands[tableId]) recentHands[tableId] = [];
  recentHands[tableId].push(slim);
  if (recentHands[tableId].length > HANDS_RING) recentHands[tableId].shift();

  // #4c/#4d detectors will be invoked from here. No-op for now.
};
```

Add module-level state near the other stores:
```js
const recentHands = {};        // tableId -> [slimHand, ...] bounded ring
const HANDS_RING = 60;         // hands retained per table for pairing analysis
```

Add the helper (place near other internal helpers):
```js
// Best-effort map of display name -> userId for players currently at a table.
// Needs access to the live seats; antiCheat doesn't import tableManager, so the
// server passes what it can. Simplest: resolve via sessions we already track.
function _resolveTableNames(tableId) {
  const map = {};
  // sessions are keyed by userId and carry latest `name`. Build reverse map.
  for (const [uid, s] of Object.entries(sessions)) {
    if (s?.name) map[s.name] = uid;
  }
  return map;
}
```

NOTE on `_resolveTableNames`: this reverse-maps by display name across ALL sessions, which is
imprecise (two users could share a display name; a user not currently in `sessions` won't
resolve). That's acceptable for the plumbing stub. If #4c/#4d need table-accurate resolution,
they will pass the actual seat list from the server. FLAG this limitation in a comment. Do NOT
over-engineer it here — a name->userId best-effort map is enough to stand up the pipe.

Clean up `recentHands[tableId]` when a table empties/closes — find where tables are torn down
(grep for where cash tables are deleted / `delete tables[`) and add
`delete recentHands[tableId]`. If there's no clean teardown point, cap total tables in the
ring by deleting the oldest when `Object.keys(recentHands).length` exceeds e.g. 500, and note
it.

## Part 2 — fix the dead isFirstAction / VPIP wiring

`antiCheat.js` reads `ctx.isPreflop && ctx.isFirstAction` (~line 559) but `isFirstAction` is
never set by any caller, so `preflopVPIP`/`preflopRaise`/`preflopTotal` never increment and
`SOLVER_EXACT_RANGES` can never fire. Fix by computing `isFirstAction` server-side and passing
it in BOTH action paths.

"First action" = this is the first voluntary action this player takes preflop this hand
(posting a blind is not voluntary). Simplest reliable signal available server-side: track per
hand whether this socket has acted yet. In each action handler (cash `playerAction` and
`sngAction`), before calling `onAction`, determine if this is the player's first action of the
hand.

Preferred low-risk approach: use handHistory's in-progress actions. If `handHistory` exposes
the active hand's actions, `isFirstAction` = no prior action by this player name this hand AND
phase is preflop. If that's awkward, add a lightweight per-hand `Set` of socketIds-who-acted
on the table object, reset at hand start.

Add to the ctx in BOTH `onAction` calls:
```js
isFirstAction: <computed boolean>,
```

Implementation choice is yours, but it MUST be accurate (true exactly once per player per
hand, on their first voluntary preflop action). If you cannot compute it reliably without
larger changes, STOP and report the cleanest option rather than shipping an approximate one —
a wrong isFirstAction corrupts VPIP stats, which is worse than leaving them dead.

## Verify
1. `node --check src/server.js src/antiCheat.js`.
2. All four endHand sites capture the return and call `onHandComplete` (or explain any site
   where it's genuinely inapplicable).
3. `onHandComplete` stores a bounded per-table ring and never throws on a fold-only hand
   (no showdown, short actions array).
4. `recentHands` has a cleanup/teardown path (or a bounded-tables fallback).
5. `isFirstAction` is now passed on both action paths and is true exactly once per player per
   hand preflop — trace one hand to confirm it isn't set on blinds or on later streets.
6. Report: is `handHistory` still writing to an ephemeral filesystem path? (Noticed
   `fs.writeFileSync`.) Do NOT fix here — just flag it for a future persistence pass.

Commit as ONE commit: `feat(anticheat): onHandComplete hook with betting sequences + fix VPIP isFirstAction wiring`

## Tripwires
- If capturing endHand's return at any site changes existing control flow (e.g. the value was
  intentionally ignored because the hand was already torn down), STOP and report.
- If `isFirstAction` can't be computed reliably without a bigger refactor, STOP and report
  options — do NOT ship an approximation.
- Do NOT add collusion detection logic in this commit. The hook stays a storing stub.
- Do NOT change onHandResult, chip-dump, or any existing detector.
