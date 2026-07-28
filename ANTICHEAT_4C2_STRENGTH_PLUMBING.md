# Anti-Cheat Plumbing — Surface per-player showdown hand strength into the hand record

## Purpose

Soft-play, whipsaw, and the fold-to-dump chip-dump pattern all need to know HOW STRONG each
player's hand was at showdown — "they never bet into each other" only means collusion if
they were holding strong hands while doing it. That data is already computed and thrown away:
`engine.showdown()` calls `bestFive(seven)` for every active seat but returns only the
winner's `hand` name. This change surfaces every player's evaluated strength so it reaches
`onHandComplete` via the hand record.

PLUMBING ONLY — no new evaluation logic (reuses existing `bestFive`/`scoreHand`), no detector
logic (that's #4d). Low risk: it exposes data the engine already produces.

Depends on #1–#4c.

## Part 1 — engine.showdown returns per-player strength (gameEngine.js)

`showdown(seats, board)` currently loops active seats calling `bestFive`, tracks winners, and
returns `{ winner, winners, hand }`. Extend it to also return a per-player strength array,
WITHOUT changing the existing return fields (callers rely on them).

In the loop, capture each seat's evaluated score. After the loop, build:
```js
const strengths = active.map(seat => {
  const seven = [...seat.cards, ...board];
  const r = bestFive(seven);           // already computed in the loop — reuse, don't recompute twice
  return {
    name: seat.name,
    handName: r.score?.name,           // e.g. "Two Pair"
    rank: _rankIndex(r.score),         // 0..8 category index (see Part 2); higher = stronger
  };
});
```
Better: capture `result` inside the existing loop into a map keyed by seat name so you don't
call `bestFive` twice per seat. Reuse the loop's computation. Then:
```js
return { winner: winners[0]?.name, winners: winners.map(s=>s.name), hand: winScore?.name, strengths };
```

Keep `winner/winners/hand` byte-identical to today. Only ADD `strengths`.

## Part 2 — expose a stable rank category index

`scoreHand` returns a score object with a `.name` (category) and tiebreak data. Detectors need
a COMPARABLE ordinal for "how strong is this hand category" (high card=0 … straight flush=8).

Check what `scoreHand`/`bestFive` already expose. If the score object already has a numeric
category rank (e.g. `score.cat` or a leading element used by `compareScore`), reuse it — do NOT
invent a parallel ranking. If the category is only encoded implicitly in `compareScore`
ordering, add a small pure helper `_rankIndex(score)` that maps the existing category to 0..8
using whatever field `scoreHand` already sets. Report which field you used. Do NOT change
`scoreHand` or `compareScore` behavior — only read from them.

This ordinal is a coarse strength proxy (category only, ignores kickers) — that's fine and
intentional; detectors want "did they have a big hand," not exact equity.

## Part 3 — carry strengths through the handResult → hand record

`_doShowdown` (tableManager.js) builds `handResult` from `result = t.engine.showdown(...)`.
Add `result.strengths` onto the handResult object at BOTH showdown return sites (the single-pot
branch ~line 441 and the side-pot branch — find where it assembles the multi-pot result):
```js
const handResult = { winner: result.winner, winners: result.winners, hand: result.hand,
  amount: net, rake, board: t.board, showCards, strengths: result.strengths };
```
For the side-pot branch, `showdown` is called per-pot; collect strengths from the FIRST/overall
evaluation (all active players are evaluated in the main-pot showdown call — reuse that one's
`strengths` for the whole hand). If multiple showdown calls happen, use the one covering the
most players. Report how you handled it.

Non-showdown results (fold wins, last-player) have no strengths — that's correct; leave the
field absent/undefined there.

## Part 4 — handHistory carries strengths into the record

`handHistory.endHand(tableId, result)` builds the persisted record. Add strengths to it so
`onHandComplete` receives them:
```js
strengths: result?.strengths || null,
```
(alongside `showCards`, `handName`, etc. in the record object).

## Part 5 — onHandComplete exposes strengths on the slim hand (antiCheat.js)

In the `slim` object built in `onHandComplete`, add a per-userId strength map so #4d can read
"userId X had rank N at showdown":
```js
strengthByUser: (record.strengths || []).reduce((m, s) => {
  const uid = nameToUser[s.name];
  if (uid) m[uid] = { rank: s.rank, handName: s.handName };
  return m;
}, {}),
```
Store it on `slim`. No detection yet — just make it available.

## Verify
1. `node --check src/gameEngine.js src/tableManager.js src/handHistory.js src/antiCheat.js`.
2. `engine.showdown` return still has identical `winner/winners/hand`; adds `strengths` array
   with one entry per active player {name, handName, rank}. Existing showdown callers unaffected.
3. `bestFive` is not called twice per seat (reuse the loop's computation).
4. A showdown hand's record now carries `strengths`; a fold-win hand does not (undefined, no
   crash downstream).
5. `onHandComplete` slim has `strengthByUser` keyed by userId for showdown hands.
6. Report: which field of the score object you used for the 0..8 rank index.

Commit as ONE commit: `feat(anticheat): surface per-player showdown hand strength into hand record`

## Tripwires
- If `engine.showdown` is called anywhere that would break by adding a field, STOP and report
  (it shouldn't — added fields are backward-compatible).
- If the side-pot branch makes multiple showdown calls and it's unclear which strengths cover
  all players, STOP and report rather than guessing.
- If `scoreHand` has NO usable category field for the ordinal and adding one would require
  changing evaluation logic, STOP and report — do not modify the evaluator.
- Do NOT add detection logic. This is plumbing for #4d.
