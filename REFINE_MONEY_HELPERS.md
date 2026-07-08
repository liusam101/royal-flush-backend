# Refinement: consolidate money rounding + equality into shared helpers

## Why (and why NOT the big rewrite)

Money is stored exactly in Postgres (`NUMERIC(12,2)`), so stored balances do not drift.
The only float exposure is in-memory JS during a hand (rake, pot splits, remainders). Today
that's handled by 9 scattered ad-hoc expressions with slightly different shapes. The risk
isn't lost money — it's INCONSISTENT rounding across sites and the maintenance hazard of
duplicated magic numbers. This change centralizes them into two helpers. It does NOT convert
anything to integer cents and does NOT touch DB types, Stripe, blinds, or display formatting.
Pure consolidation, behavior-preserving.

## The helpers

Add to a shared spot. Preferred: a tiny new module `src/money.js` so both tableManager.js
and server.js can import it:

```js
// src/money.js — shared money rounding + comparison.
// Money is dollars-as-float in memory, exact NUMERIC(12,2) in the DB.
// These helpers keep in-memory rounding consistent everywhere.

// Round to whole cents, avoiding float artifacts (e.g. 1.005 → 1.01).
function roundMoney(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}

// True if two money amounts are equal to the cent (tolerant of float noise).
function moneyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

// True if a money delta is non-negligible (>= half a cent).
function moneyNonZero(x) {
  return Math.abs(Number(x)) >= 0.005;
}

module.exports = { roundMoney, moneyEqual, moneyNonZero };
```

NOTE on the threshold change: current code uses `> 0.001`; the helper uses `>= 0.005`
(half a cent). This is intentional and more correct — anything under half a cent rounds to
$0.00 and should be treated as zero. Confirm this doesn't mask a real case: the deltas being
compared are always differences between already-cent-rounded balances, so a legitimate delta
is never between 0.001 and 0.005. If you find a site where sub-half-cent precision matters,
STOP and report instead of converting it.

Also add the `Number.EPSILON` nudge note: current rake code is `Math.round(x*0.025*100)/100`
without the epsilon; `roundMoney` adds `Number.EPSILON` which corrects exact-half-cent cases
like `1.005`. This is a behavior improvement, not a regression, but call it out per site so
the change is understood.

## Replacements

### src/tableManager.js
Add `const { roundMoney } = require('./money');` at top (with other requires).

- Line ~185 and ~331 (fold rake):
  `Math.min(Math.round(t.pot * 0.025 * 100) / 100, 3.00)`
  → `Math.min(roundMoney(t.pot * 0.025), 3.00)`
- Line ~405 (showdown rake):
  `Math.min(Math.round(totalPot * 0.025 * 100) / 100, 3.00)`
  → `Math.min(roundMoney(totalPot * 0.025), 3.00)`
- Line ~414 and ~432 (penny remainder):
  `Math.round((net - share * winSeats.length) * 100) / 100`
  → `roundMoney(net - share * winSeats.length)`
  (and the `sp.amount` variant likewise)

Do NOT change the `Math.floor(... / winSeats.length * 100) / 100` share-splitting lines —
floor is intentional there (never over-distribute; remainder handled separately). Leave them.

### src/server.js
Add `const { moneyNonZero } = require('./money');` at top.

- Lines ~147, ~164, ~414, ~821: replace `Math.abs(<expr>) > 0.001` with
  `moneyNonZero(<expr>)`. For line 147 `entries.filter(e => Math.abs(e.delta) > 0.001)` →
  `entries.filter(e => moneyNonZero(e.delta))`, etc.

## What must NOT change

- DB column types, any SQL, Stripe amounts.
- `toFixed(...)` display formatting anywhere (that's UI, leave all 23).
- Blind/stake decimal literals.
- The `Math.floor` share-split lines.
- Rake percentage (0.025) and cap (3.00).

## Verify

1. `grep -n "Math.round(.*\* 100) / 100\|> 0.001" src/*.js` → zero results in tableManager.js
   and server.js money sites (only display/other non-money uses, if any, remain — report them).
2. `node --check src/money.js src/tableManager.js src/server.js`.
3. Sanity-trace one hand: pot $10.00, rake = roundMoney(10 * 0.025) = roundMoney(0.25) =
   0.25, net $9.75. Split between 2 winners: floor(9.75/2*100)/100 = 4.87 each, remainder
   roundMoney(9.75 - 9.74) = 0.01 to first winner. Totals reconcile to 9.75. Confirm.

Commit as ONE commit: `refactor: centralize money rounding/comparison into src/money.js`

## Tripwire

- Any `> 0.001` site whose expression is NOT a money delta (e.g. a probability, a time, a
  ratio) → do NOT replace it; report it.
- If a money site needs sub-half-cent precision → STOP and report.
