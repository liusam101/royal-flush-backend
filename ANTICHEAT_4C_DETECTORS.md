# Anti-Cheat Refactor #4c — High-confidence detectors + two prerequisite fixes

Conservative posture throughout (per the chosen stance): flag only strong signals, all
advisory (human-review), no auto-action beyond what #3 already does for ban-matches. Four
parts, all in one commit. Depends on #1–#4b.

---

## Part 1 (PREREQUISITE) — fix `totalHands`: it never increments

`grep totalHands` shows it's initialized to 0, READ by the stats analyzer (`< 80` gate at
~205, `> 200` gate at ~215), but INCREMENTED NOWHERE. So `analyzeStats`/`SOLVER_EXACT_RANGES`
can never fire — those detectors are fully dead. Also `handsPlayed` increments only for the
winner (in `onHandResult`), so it counts hands-won, not hands-played.

Fix in `onHandResult` (antiCheat.js): increment `totalHands` for BOTH winner and every loser
(everyone who played the hand), and align `handsPlayed` with it. In the current body:

- `winnerSess`: already does `handsPlayed++`. Add `winnerSess.totalHands++;`
- `loserSess`: add `loserSess.totalHands++; loserSess.handsPlayed++;` (currently a loser's
  hand count never moves).

NOTE the asymmetry today: `onHandResult` is called once per loser (server loops losers), but
ONCE total for the winner across those calls — verify. If the server calls `onHandResult` once
per (winner,loser) pair, the winner would be double-counted. CHECK the call site (server.js
~807, inside `loserSeats.forEach`): the winner IS passed on every loser iteration. So
incrementing winner in `onHandResult` would over-count the winner by (#losers). To avoid this,
increment the winner's `totalHands`/`handsPlayed` ONLY on the first call for that hand.
Cleanest: pass a per-hand flag, OR increment the winner exactly once using `onHandComplete`
(which fires once per hand) instead. RECOMMENDED: move per-hand counting to `onHandComplete`
(fires exactly once per hand, has `slim.seats` = userIds present) — increment `totalHands`
(and `handsPlayed`) once for every userId in `slim.seats`. Then REMOVE the per-winner
`handsPlayed++` from `onHandResult` to avoid double counting. Keep win/loss/showdown tallies
in `onHandResult` (those are correctly per-outcome). Verify no other code depends on the old
`handsPlayed` semantics.

Trace to confirm: a 3-player hand → each of the 3 userIds gets `totalHands += 1` exactly once.

## Part 2 (PREREQUISITE) — wire `recordAction` into the SNG path

`handHistory.recordAction` is only called on the cash path (~802), so SNG hands reach
`onHandComplete` with an empty `actions[]` — collusion detectors would be blind to tournament
play. Mirror the cash call in `sngAction`.

In `sngAction` (server.js ~1311, right where the cash path calls it relative to
`setPlayerStack`/`onAction`), add:
```js
handHistory.recordAction(tableId, mySeat?.name || '?', action, amount, preState);
```
Place it at the same logical point the cash path does (after the anti-cheat `onAction`, before
`tableManager.handleAction`). Confirm `handHistory.startHand` is also called for SNG hands —
grep `handHistory.startHand`; if it's only wired for cash, SNG `recordAction` would have no
active hand to append to. If SNG hands never call `startHand`, REPORT it (that's a bigger gap)
rather than silently having recordAction no-op.

## Part 3 — Same-table multi-accounting (HIGHEST confidence)

The existing `SAME_IP_SAME_TABLE` fires when 2+ distinct userIds at one table share an IP.
Strengthen into a higher-confidence multi-account signal by ALSO checking device fingerprint,
and escalating severity when BOTH IP and fingerprint match (that combination is close to
deterministic — same person, two accounts, same table):

In `checkIPCollision` (rename conceptually to `checkSameTableMultiAccount` or keep name), after
the existing IP grouping, add fingerprint grouping over the same seats:
- Group seat userIds by `sessions[userId]?.fingerprint`.
- If 2+ distinct userIds at the table share a fingerprint → this is stronger than IP alone
  (IP is shared by households; fingerprint collisions are rarer). Emit `DEVICE_SAME_TABLE`
  at SEV.HIGH.
- If a set of userIds shares BOTH the same IP AND the same fingerprint → emit
  `MULTI_ACCOUNT_SAME_TABLE` at SEV.CRITICAL (advisory — NOT in the #3 auto-eject set; this
  is for priority human review, since even fp+IP can rarely collide on shared devices).

Keep conservative: require the SAME set of 2+ distinct userIds, and dedupe (a single userId on
two tabs = two sockets, one userId — must NOT self-flag; the existing code already keys by
userId so confirm the dedupe holds for the fp path too).

Do NOT auto-act on any of these — they route to review. (Per #3, only ban-MATCH types
auto-eject; a fresh multi-account detection is a review item, because a wrong CRITICAL here
would eject an innocent.)

## Part 4 — Strengthen chip-dump detection

Current `checkChipDump` catches: repeated losses to the same winner (`CHIP_DUMP_PATTERN`) and
single large stack-fraction losses (`CHIP_DUMP_LARGE`). Add two conservative refinements:

**4a. Directional consistency (one-way flow).** Real chip-dumping is one-directional (A always
loses to B, never the reverse). Using the collusion graph (already keyed by userId), when
`CHIP_DUMP_PATTERN` would fire, also check the REVERSE direction: how much has `winner` lost
back to `loser` in the same window? If flow is heavily one-way (e.g. loser→winner total is
≥ 5× winner→loser total AND ≥ DUMP_THRESHOLD hands), escalate to `CHIP_DUMP_DIRECTIONAL` at
SEV.HIGH with both totals in the detail. If flow is roughly balanced, it's likely normal
variance between two regulars — do NOT escalate (keeps false positives down). This requires
reading both directions from the collusion graph; confirm the graph stores directional edges
(from #1 it stores winner/loser pairs — verify it can answer "A→B total" and "B→A total"
separately; if it only stores undirected pairs, add direction).

**4b. Fold-to-dump pattern (needs #4b betting sequences).** A common dump: the "loser" bets
big into the "winner" on early streets then the winner just calls, OR the loser open-shoves
into the winner who snap-calls with the loser showing down a weak hand. Using
`recentHands[tableId]` (from #4b), when a large pot flows loser→winner, check the hand's
`actions`: if the loser committed most chips with NO showdown OR an abnormally weak showdown
while the winner played passively, add a weak signal toward the chip-dump score. KEEP THIS
CONSERVATIVE: only contribute to an existing suspicion when the money-flow signal is ALSO
present — do NOT raise a standalone alert from betting-pattern alone (too noisy). If the data
needed (showdown hand strength) isn't in the record, skip this sub-part and REPORT that
showdown hand-strength isn't available — do not guess.

## Verify
1. `node --check src/antiCheat.js src/server.js`.
2. `totalHands` now increments once per hand for every participant; trace a 3-player hand → +1
   each. Confirm no double-count of the winner.
3. SNG `recordAction` wired; confirm SNG `startHand` exists (or report the gap).
4. Same-table detection: 2 userIds sharing fp → DEVICE_SAME_TABLE; sharing fp+IP →
   MULTI_ACCOUNT_SAME_TABLE (CRITICAL, advisory, NOT auto-ejected). One userId on 2 tabs → no
   flag (dedupe holds).
5. Chip-dump directional: one-way flow escalates; balanced flow does not.
6. Confirm NONE of the new alerts are added to #3's AUTO_EJECT_TYPES.

Commit as ONE commit: `feat(anticheat): fix totalHands + SNG recordAction; add same-table multiaccount + directional chip-dump`

## Tripwires
- If incrementing `totalHands` in `onHandComplete` conflicts with any existing per-hand
  counting, STOP and report before double-wiring.
- If SNG hands don't call `handHistory.startHand`, STOP and report (recordAction would no-op).
- If the collusion graph can't answer directional A→B vs B→A totals, report before forcing it.
- If showdown hand-strength isn't in the hand record, skip Part 4b and report — don't guess.
- Do NOT add any new alert type to AUTO_EJECT_TYPES. All #4c signals are advisory.
- Conservative posture: if unsure whether a threshold is too loose, err tighter and note it.
