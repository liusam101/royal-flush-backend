# Anti-Cheat Refactor #4d — Soft-play & whipsaw detection (conservative, advisory)

The final detector. CONSERVATIVE posture: flag only strong, REPEATED multi-hand patterns
between the SAME pair. All signals advisory (feed suspicion score + review queue), NONE added
to AUTO_EJECT_TYPES. Uses the hand-strength data plumbed in the previous brief.

Depends on #1–#4c + strength plumbing. All logic lives in antiCheat.js, invoked from the
existing `onHandComplete` hook (which already has `slim.actions` with per-action user/action/
phase/amount, `slim.strengthByUser` with per-userId {rank, handName}, and `slim.seats`).

## Core data model — per-pair accumulators

Add a per-pair stats store keyed by a canonical unordered pair key:

```js
const pairStats = {};   // "uidA|uidB" (sorted) -> accumulator
const PAIR_RING_HANDS = 200;   // rolling window of shared hands per pair
function _pairKey(a, b) { return [a, b].sort().join('|'); }
function _getPair(a, b) {
  const k = _pairKey(a, b);
  if (!pairStats[k]) pairStats[k] = {
    sharedHands: 0,            // hands both were dealt into
    softplayEvents: 0,        // hands showing the soft-play signature
    softplayStrong: 0,        // soft-play events where BOTH held strong hands
    whipsawEvents: 0,         // hands showing the whipsaw signature vs a third party
    lastHands: [],            // recent hand ids for the window (bounded)
    flaggedSoftplay: false,   // de-dupe: only alert once per escalation
    flaggedWhipsaw: false,
  };
  return pairStats[k];
}
```

Bound growth: cap total pairs (e.g. 5000); when exceeded, evict the pair with the oldest
`lastHands` timestamp. Clean pairs when both users have been offline a long time is optional —
prioritize the cap. Note the approach.

## Thresholds (conservative — err tighter; comment each as tunable)

```js
const STRONG_RANK = 2;          // tier >= 2 (Two Pair+) counts as "strong" for soft-play
const SOFTPLAY_MIN_SHARED = 25; // need >=25 shared hands before soft-play can flag
const SOFTPLAY_MIN_STRONG = 6;  // >=6 strong-hand soft-play events between the pair
const SOFTPLAY_RATE = 0.55;     // AND soft-play events >=55% of their strong shared showdowns
const WHIPSAW_MIN_SHARED = 25;
const WHIPSAW_MIN_EVENTS = 5;   // >=5 whipsaw-signature hands vs third parties
```

All advisory. These are deliberately high to protect the review queue; they can be loosened
later against real data. Put a comment saying so.

## Detection 1 — Soft-play

Signature, evaluated per completed hand for each pair (A,B) both dealt in and both reaching
showdown together:

1. Both A and B are in `slim.seats` and both appear in `slim.strengthByUser` (both showed
   down — soft-play requires they didn't fold to each other).
2. Neither A nor B put in a raise/bet that the OTHER had to call on any street where they were
   heads-up in the pot — i.e. across `slim.actions`, filter to A's and B's actions; if neither
   ever `bet`/`raise`d into a pot the other was contesting, the "no aggression between them"
   condition holds. (Approximate with: neither A nor B has a `bet` or `raise` action on a
   street where the other also acted without folding. Keep it simple and readable.)
3. This is a soft-play EVENT. Increment `pair.softplayEvents`.
4. If BOTH held `rank >= STRONG_RANK` at showdown → increment `pair.softplayStrong` (the
   high-signal case: they checked down strong hands to each other).

Escalation (only when a hand is added):
```js
if (pair.sharedHands >= SOFTPLAY_MIN_SHARED &&
    pair.softplayStrong >= SOFTPLAY_MIN_STRONG &&
    (pair.softplayStrong / Math.max(pair.strongShowdownsTogether,1)) >= SOFTPLAY_RATE &&
    !pair.flaggedSoftplay) {
  pair.flaggedSoftplay = true;   // once per escalation; reset if pattern decays (optional)
  alert(A, 'SOFTPLAY_PAIR', SEV.MEDIUM, `<detail>`, {pair, ...});
  alert(B, 'SOFTPLAY_PAIR', SEV.MEDIUM, `<detail>`, {pair, ...});
}
```
Track `pair.strongShowdownsTogether` (hands where both showed down with rank>=STRONG_RANK,
regardless of aggression) so the RATE denominator is meaningful — it distinguishes "they
NEVER bet strong hands into each other" (suspicious) from "they occasionally check down"
(normal). SEV.MEDIUM because even this can be coincidence between two passive players; it's a
review prompt, not a conviction.

## Detection 2 — Whipsaw

Signature per hand, for a pair (A,B) acting against a third player C:

1. A, B, and at least one other player C are in the hand.
2. On a single street, A raises, then B RE-raises (or vice versa), with C in between having to
   call escalating action — i.e. the pair's raises sandwich C. Detect from `slim.actions`
   ordering on one `phase`: a raise by A, a raise by B, and a call/fold by C at higher amount
   between or after them.
3. The pair do NOT both have strong hands (`strengthByUser`): if both A and B showed down
   `rank >= STRONG_RANK`, it's likely a legit cooler, NOT whipsaw — do NOT count it. Whipsaw
   is trapping with at least one WEAK/medium hand (the raises are pressure, not value).
   If the hand didn't reach showdown for the pair, treat unknown strength as "not both strong"
   (can still count) — but require the raise-sandwich structure to be unambiguous.
4. Count as a whipsaw event: `pair.whipsawEvents++`.

Escalation:
```js
if (pair.sharedHands >= WHIPSAW_MIN_SHARED &&
    pair.whipsawEvents >= WHIPSAW_MIN_EVENTS && !pair.flaggedWhipsaw) {
  pair.flaggedWhipsaw = true;
  alert(A, 'WHIPSAW_PAIR', SEV.MEDIUM, `<detail>`, {...});
  alert(B, 'WHIPSAW_PAIR', SEV.MEDIUM, `<detail>`, {...});
}
```
SEV.MEDIUM — whipsaw is the noisiest signal (aggressive players naturally re-raise); this is
explicitly a weak prompt for human review, weighted low.

## Wiring into onHandComplete

At the end of `onHandComplete`, after building `slim`, iterate unordered pairs of userIds in
`slim.seats`:
```js
const uids = slim.seats.filter(Boolean);
for (let i=0;i<uids.length;i++) for (let j=i+1;j<uids.length;j++) {
  const pair = _getPair(uids[i], uids[j]);
  pair.sharedHands++;
  _evalSoftplay(pair, uids[i], uids[j], slim);
  _evalWhipsaw(pair, uids[i], uids[j], slim, uids);
}
```
Keep `_evalSoftplay`/`_evalWhipsaw` as small pure-ish helpers reading `slim`. They must not
throw on hands with empty `actions` (SNG hands now populate actions, but fold-only/edge hands
may be short) — guard array access.

## Suspicion score

Both detectors, on a counted EVENT (not just on escalation), add a small increment to each
user's suspicion score via the existing mechanism (whatever `alert`/session scoring uses).
Keep increments small so a few coincidences don't cross thresholds — the ESCALATION alert is
the actionable output; the per-event score is ambient weighting. If the existing suspicion
model only moves on `alert()`, then just rely on the escalation alerts and skip per-event
scoring — report which you did.

## Verify
1. `node --check src/antiCheat.js`.
2. Trace soft-play: build a mental `slim` where A and B both show down tier-3 hands with no
   bets/raises between them, repeated 6+ times over 25+ shared hands → SOFTPLAY_PAIR fires
   once (not per hand). A pair that sometimes bets into each other stays under RATE → no flag.
3. Trace whipsaw: A raises, B re-raises, C caught between, neither A/B strong → counts; same
   structure but both A/B show down strong → does NOT count (cooler). 5+ events over 25+ hands
   → WHIPSAW_PAIR once.
4. Two passive-but-honest players (check down weak hands, never strong) → softplayStrong stays
   low → no flag. Confirm the STRONG-hand gating is what prevents nitty-player false positives.
5. Confirm SOFTPLAY_PAIR and WHIPSAW_PAIR are NOT in AUTO_EJECT_TYPES (grep server.js).
6. Confirm pairStats has a growth cap.

Commit as ONE commit: `feat(anticheat): conservative soft-play + whipsaw pair detection (advisory)`

## Tripwires
- If `slim.actions` lacks the per-street ordering needed to detect a raise-sandwich reliably,
  STOP and report what's available rather than shipping a guess that false-positives.
- If `slim.strengthByUser` is null on a hand (fold win), soft-play/whipsaw strength checks
  must degrade safely (soft-play needs showdown, so no showdown = no soft-play event; whipsaw
  treats unknown as "not both strong"). Confirm no crash.
- Do NOT add these to AUTO_EJECT_TYPES.
- Do NOT loosen the thresholds below what's specified — conservative is the chosen posture.
- If unsure whether a heuristic is too noisy, make it TIGHTER and note it for later tuning.
