# Crash recovery: tournament/SNG buy-ins survive a server restart — db.js + server.js

## Context — what's already safe (do NOT build recovery for this)

Cash tables need NO crash recovery. Joining a cash table never writes to the DB; balances
are only updated via per-hand settlement deltas (atomic since the settleHandChips
refactor). A crash mid-hand therefore leaves every player's DB balance exactly as of their
last completed hand — the interrupted hand cancels naturally. This is correct behavior.
ADD A COMMENT documenting this invariant at the top of `settleHandChips` in server.js:
"Cash-table crash safety depends on the DB only ever being written via settlement deltas.
Never debit cash-table buy-ins from the DB at join time."

## The actual exposure — tournaments and SNGs

At SNG/MTT registration, `server.js` debits the buy-in immediately:
`await updateChips(socket.userId, -actualBuyIn, 0)` (royal chips). Prizes are credited
only at elimination/win (`updateChips(userId, prize, 0)`). All tournament state
(registrations, stacks, prize structures) is in memory. A crash mid-tournament destroys
every live entrant's buy-in with no record it ever existed.

## The fix — a persistent entry ledger + boot-time refund sweep

### Change 1 — new table (db.js, in initDB alongside the other CREATE TABLE IF NOT EXISTS)

```sql
CREATE TABLE IF NOT EXISTS tournament_entries (
  id         SERIAL PRIMARY KEY,
  tourn_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  username   TEXT,
  buy_in     NUMERIC(12,2) NOT NULL,
  prize      NUMERIC(12,2) NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active',  -- active | settled | refunded
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tournament_entries_status ON tournament_entries(status);
```

Match the existing initDB style. If the users table's id column is a different type than
TEXT, match it.

### Change 2 — registration: debit + ledger row atomically (server.js)

In the SNG/tournament register path where the buy-in debit happens, replace the bare
`updateChips(socket.userId, -actualBuyIn, 0)` with a single transaction that does both
(only when `getPool()` is truthy — keep the plain call as dev fallback):

```js
if (getPool()) {
  await withTransaction(async (client) => {
    await updateChips(socket.userId, -actualBuyIn, 0, client);
    await client.query(
      `INSERT INTO tournament_entries (tourn_id, user_id, username, buy_in, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [tourn.id, socket.userId, socket.username || playerName, actualBuyIn]);
  });
} else {
  await updateChips(socket.userId, -actualBuyIn, 0);
}
```

Keep the existing failure handling (unregister + error emit) — a thrown transaction lands
in the existing catch. Mirror the existing guard exactly: only for authenticated users
with actualBuyIn > 0 (guests never debit, so they get no row).

CHECK: search server.js for any OTHER place a tournament/SNG buy-in is debited (grep
`-actualBuyIn`, `-buyIn`, `updateChips(.*-`). If there's a second registration path
(e.g. MTT vs SNG handled separately), apply the same pattern there. Report what you find.

CHECK: is there a user-initiated unregister path that refunds the buy-in? If a refund
exists, wrap it the same way (credit + mark row 'refunded' atomically). If unregistering
does NOT refund the debit today, that is a pre-existing bug — REPORT it, do not fix it in
this commit.

### Change 3 — prize/elimination settlement marks the ledger (server.js)

Where prizes are credited (the elimination loop `updateChips(elimSkt.userId, elim.prize, 0)`
and the winner credit `updateChips(wSkt.userId, winnerPlayer.prize, 0)`), atomically
credit the prize AND settle the ledger row:

```js
await withTransaction(async (client) => {
  if (prizeAmount > 0) await updateChips(userId, prizeAmount, 0, client);
  await client.query(
    `UPDATE tournament_entries SET status='settled', prize=$1, updated_at=now()
     WHERE tourn_id=$2 AND user_id=$3 AND status='active'`,
    [prizeAmount, tournId, userId]);
});
```

This must ALSO run for zero-prize eliminations (prizeAmount 0, skip the credit, still
settle the row) — find where players are eliminated without a prize and settle there. If
eliminations for prize-0 players don't currently touch the DB at all, add the row-settle
call at the same point the elimination is processed. Keep the existing `.catch(() => {})`
fire-and-forget style of these call sites (log failures instead of swallowing:
`console.error('[TournLedger]', e.message)`).

Guests (no userId) have no rows — keep the existing userId guards.

### Change 4 — boot-time refund sweep (server.js startup)

After `initDB()` succeeds at boot, before accepting connections:

```js
async function recoverOrphanedTournamentEntries() {
  if (!getPool()) return;
  const rows = (await dbQuery(
    `SELECT id, tourn_id, user_id, username, buy_in FROM tournament_entries
     WHERE status='active'`)).rows;
  for (const r of rows) {
    try {
      await withTransaction(async (client) => {
        await updateChips(r.user_id, Number(r.buy_in), 0, client);
        await client.query(
          `UPDATE tournament_entries SET status='refunded', updated_at=now() WHERE id=$1`,
          [r.id]);
      });
      console.log(`[Recovery] Refunded $${r.buy_in} tournament buy-in to ${r.username || r.user_id} (tourn ${r.tourn_id})`);
    } catch (e) {
      console.error(`[Recovery] FAILED refund entry ${r.id}:`, e.message);
    }
  }
  if (rows.length) console.log(`[Recovery] Processed ${rows.length} orphaned tournament entries.`);
}
```

Rationale: any 'active' row at boot belongs to a tournament that no longer exists in
memory (all tournaments died with the process). Refund the buy-in. Players who already
busted have 'settled' rows and correctly get nothing; live players get their buy-in back;
the house eats the rake on cancelled tournaments (standard).

Call it in the startup sequence after DB init. Verify the startup flow: find where
`initDB` is awaited and add the call immediately after, before `server.listen` if the
ordering allows; if listen happens first in the current structure, call it right after
initDB regardless and note the ordering.

### Known limitations (add as comments, do not solve)

- Single-replica assumption: two instances booting simultaneously could double-refund.
  Current deployment is 1 replica. Note it.
- A crash in the milliseconds between an elimination event and its ledger settle
  over-refunds that one player's buy-in on recovery. Acceptable: rare, small, and errs
  toward the player.

## Acceptance tests (hand-trace + one live test)

1. Register for an SNG → `tournament_entries` row appears, status 'active', balance
   debited. (Live-verifiable via the Transactions page or DB console.)
2. Bust out of an SNG with no prize → row flips to 'settled', prize 0.
3. Win an SNG → prize credited AND row 'settled' with prize recorded, atomically.
4. Register, then restart the Railway service mid-tournament → on boot, log shows
   `[Recovery] Refunded ...`, balance restored, row 'refunded'.
5. Cash table crash mid-hand → NO recovery action, balance = last settled hand
   (unchanged behavior, now documented).

## Must NOT change

- Cash-table join/settlement flow (comment only).
- Prize amounts, rake percentages, prize structures.
- The registration failure/unregister error handling shape.

`node --check src/server.js src/db.js`.
Commit as ONE commit: `feat: tournament entry ledger + boot-time refund of orphaned buy-ins`

## Tripwires

- Second registration/debit path found → apply pattern there too and report.
- Unregister path that doesn't refund → REPORT as pre-existing bug, don't fix here.
- If prize credits happen anywhere other than the two call sites described → report all
  sites found before proceeding.
- Any mismatch with descriptions above → STOP and report.
