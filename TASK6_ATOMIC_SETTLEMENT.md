# Task 6 — Atomic Chip Settlement (implementation brief)

Goal: all chip balance changes for a single settled hand commit or roll back **together**,
so a crash mid-settlement can never leave a pot half-distributed.

This touches the money path. Follow the constraints exactly. Do NOT change any game
logic, stat semantics, or the amounts being written — only *when/how* they are written.

Repo: `royal-flush-backend`.

---

## Current state (read this first, verify it matches)

- `src/db.js` already exports `withTransaction(fn)` — BEGIN/COMMIT/ROLLBACK around a
  callback that receives a `client`.
- `src/auth.js` → `updateChips(userId, deltaRoyal, deltaGold)` runs one or two UPDATE
  statements via the shared pool (`db.query`). It also has a JSON-file fallback when
  there is no `DATABASE_URL` (local dev).
- `src/server.js` contains **four near-identical settlement loops** that iterate a
  table's final seats and call `await updateChips(...)` per seat, then update the
  in-memory `skt.chips`, call `rg.recordLoss(...)`, and fire `updateStats(...)`:
  1. In the `playerAction` handler, inside `if (result.handOver)` (~line 330).
     This one computes `isShowdown` and passes showdown stats.
  2. In the `leaveTable` handler, inside `if (leaveResult?.handResult)` (~line 384).
     Stats here use `amountLost: 0, showdownWin: 0, showdownPlayed: 0`.
  3. In the `disconnect` handler, looping `handResults` (~line 759).
     Stats use real `amountLost`, `showdownWin: 0, showdownPlayed: 0`.
  4. In the auto-fold callback near the bottom of the file (~line 840).
     Same stats shape as (3).

Single-row chip updates elsewhere (SNG buy-in debit, SNG prize credits, cash-out on
leave, disconnect-timeout reconciliation) are **out of scope** — one UPDATE statement
is already atomic on its own. Do not touch them.

---

## Step 1 — Make `updateChips` transaction-aware

In `src/auth.js`, change the signature to accept an optional query executor:

```js
async function updateChips(userId, deltaRoyal, deltaGold, client = null) {
  if (useDB) {
    const run = client
      ? (sql, params) => client.query(sql, params)
      : (sql, params) => db.query(sql, params);
    if (deltaRoyal) await run(
      'UPDATE users SET chips = GREATEST(0, chips + $1) WHERE id=$2', [deltaRoyal, userId]);
    if (deltaGold) await run(
      'UPDATE users SET gold_chips = GREATEST(0, gold_chips + $1) WHERE id=$2', [deltaGold, userId]);
  } else {
    // JSON fallback unchanged
    ...existing code...
  }
  return true;
}
```

All existing callers pass no `client` and behave exactly as before. Do not change
`updateStats` — stats are best-effort and stay outside the transaction.

## Step 2 — Extract one shared settlement helper in `src/server.js`

Add near the other helpers (e.g. below `tryStartNewHand`):

```js
const { withTransaction, getPool } = require('./db');

// Settles all authenticated players' chip deltas for one finished hand ATOMICALLY,
// then applies in-memory/side effects only after the DB commit succeeds.
// statsMode: 'showdown' (playerAction), 'leave' (leaveTable), 'fold' (disconnect/autofold)
async function settleHandChips(tableId, hr, statsMode) {
  const finalState = tableManager.getTableState(tableId);
  if (!finalState?.seats) return;

  // Phase 1 — collect deltas (no writes yet)
  const entries = [];
  for (const seat of finalState.seats) {
    const skt = io.sockets.sockets.get(seat.socketId);
    if (!skt?.userId) continue;
    const trueNow = (skt.offTableChips ?? 0) + seat.stack;
    const delta = trueNow - (skt.chips || 0);
    entries.push({ seat, skt, trueNow, delta });
  }

  // Phase 2 — apply all non-zero chip deltas in ONE transaction
  const toWrite = entries.filter(e => Math.abs(e.delta) > 0.001);
  if (toWrite.length) {
    if (getPool()) {
      await withTransaction(async (client) => {
        for (const e of toWrite) {
          await updateChips(e.skt.userId, e.delta, 0, client);
        }
      });
    } else {
      // Local dev JSON fallback — no transactions available; sequential as before
      for (const e of toWrite) await updateChips(e.skt.userId, e.delta, 0);
    }
  }

  // Phase 3 — post-commit side effects (only runs if the transaction succeeded)
  const isShowdown = statsMode === 'showdown' && hr?.reason === 'showdown';
  for (const e of entries) {
    if (Math.abs(e.delta) > 0.001) e.skt.chips = e.trueNow;
    const isWinner = e.seat.name === hr?.winner;
    if (!isWinner && e.delta < 0 && statsMode !== 'leave')
      rg.recordLoss(e.skt.userId, Math.abs(e.delta)).catch(() => {});
    updateStats(e.skt.userId, {
      handPlayed: 1,
      won: isWinner ? 1 : 0,
      amountWon: isWinner ? (hr?.amount || 0) : 0,
      amountLost: (statsMode !== 'leave' && !isWinner && e.delta < 0) ? Math.abs(e.delta) : 0,
      showdownWin: isShowdown && isWinner ? 1 : 0,
      showdownPlayed: isShowdown ? 1 : 0,
    }).catch(() => {});
  }
}
```

Behavior-parity notes (verify against the existing loops before replacing them):
- `playerAction` loop: recordLoss on losers with negative delta → statsMode 'showdown'
  reproduces this, and showdown stats only when `hr.reason === 'showdown'`. Matches.
- `leaveTable` loop: it does NOT call recordLoss and uses amountLost 0 → 'leave' mode
  reproduces this. Matches.
- `disconnect` + auto-fold loops: recordLoss yes, real amountLost, no showdown stats →
  'fold' mode reproduces this. Matches.
- In-memory `skt.chips` update: currently happens per-seat immediately after its
  individual UPDATE; in the helper it happens only after the whole transaction commits.
  This is the intended improvement (memory never diverges from a half-written DB state).

## Step 3 — Replace the four loops with helper calls

Each of the four sites currently does:
`const finalState = tableManager.getTableState(...); if (finalState?.seats) { for (...) {...} }`

Replace that whole block (from the `finalState` fetch through the end of its seat loop)
with a single call, keeping everything around it (emits, handHistory.endHand,
setTimeout(tryStartNewHand)) unchanged:

1. `playerAction` handOver block → `await settleHandChips(tableId, hr, 'showdown');`
2. `leaveTable` handResult block → `await settleHandChips(tableId, hr, 'leave');`
3. `disconnect` handResults loop → `await settleHandChips(tableId, hr, 'fold');`
4. auto-fold callback → `await settleHandChips(tid, hr, 'fold');`

Wrap each call in try/catch that logs `[Settle] failed for <tableId>: <err>` — a failed
settlement must not crash the socket handler. (On failure the DB rolled back and
`skt.chips` was not touched, so the next successful settlement's delta computation will
self-correct, same as today's behavior after a missed write.)

## Step 4 — Verify

1. `node --check src/server.js src/auth.js src/db.js` — all pass.
2. Grep `src/server.js`: the four old inline loops are gone; exactly four
   `settleHandChips(` call sites exist; no remaining `updateChips(skt.userId` /
   `updateChips(seat` style per-seat calls inside hand-over blocks.
3. Confirm the out-of-scope single updates (SNG buy-in/prizes, cash-out, disconnect
   timeout) are untouched.
4. Commit as ONE commit: `refactor: atomic per-hand chip settlement via single DB transaction`

## Do NOT

- Do not put `updateStats` or `rg.recordLoss` inside the transaction.
- Do not change any delta math, rake logic, or tableManager code.
- Do not batch multiple hands or tables into one transaction.
- If anything in the current code does not match the "Current state" description above,
  STOP and report the discrepancy instead of adapting on the fly.
