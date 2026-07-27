# Anti-Cheat Refactor #1 of 4 — Key all player state on userId, not socketId

## The problem this fixes

Every accumulating structure in `antiCheat.js` is keyed by `socketId` (a per-connection id
that changes on every reconnect, table change, or network blip). `onDisconnect` even does
`delete sessions[socketId]` / `delete flagged[socketId]`, destroying all accumulated
evidence when a player disconnects. Result: the sample-size thresholds (80 hands, 50
showdowns, 200 hands) are effectively never reached, and a cheater wipes their history
just by reconnecting. This refactor makes all player-level accumulation key on `userId`
(the authenticated account) so evidence persists across connections within a process.

This is refactor 1 of 4. It does NOT add DB persistence (that's #2) — accumulation still
lives in memory, but now survives reconnects within a running process. Do the others after.

## Key design decisions (follow exactly)

- **Player identity = `userId`** for all accumulation: `sessions`, `flagged`,
  `collusionGraph`, chip-dump history, timing history, stats, suspicion score.
- **Guests (no userId): skip anti-cheat accumulation entirely.** Real-money and gold play
  require auth, so guests never reach money tables. For any call where `userId` is null,
  the anti-cheat functions should no-op gracefully (return early, no crash). Do NOT invent
  a synthetic id for guests — just skip.
- **Ephemeral, per-connection things stay keyed by socketId:** velocity `actionBuckets`
  (rate-limiting is inherently per-connection) and the `ipMap`/`fpMap` live-connection sets
  used to detect concurrent multi-accounting. These are about "this connection right now,"
  not accumulated history. Keep them socket-keyed. Document why with a comment.
- **A socket→userId lookup** is needed because some call sites (velocity, IP collision from
  seat lists) only have socketId. Maintain `const socketToUser = {}` updated on connect and
  cleaned on disconnect.

## Server-side changes (server.js) — pass userId into every anti-cheat call

`socket.userId` is set at socket connect (JWT handshake, ~line 574) and IS available at
every anti-cheat call site. Guests have `socket.userId === undefined`.

Update these call sites to pass `socket.userId` (and keep socketId where noted):

1. `antiCheat.onConnect(socket.id, playerName, ip, fp)` (~663)
   → `antiCheat.onConnect(socket.id, socket.userId, playerName, ip, fp)`
2. `antiCheat.onAction(socket.id, action, tableId, {...})` (~759) and the SNG path
   `antiCheat.onAction(socket.id, action, tableId)` (~1270)
   → add `socket.userId` as an argument: `onAction(socket.id, socket.userId, action, tableId, ctx)`
   (NOTE: the SNG path currently passes NO ctx — that's a separate fix in refactor #4; for
   now just add userId and leave ctx absent there.)
3. `antiCheat.onHandResult(tableId, {...})` (~797) — the handData object already carries
   `winnerSocket`/`loserSocket`. ADD `winnerUserId` and `loserUserId` to the object. Get
   them via the socket→user map or from the seats (seats don't carry userId; use
   `socketToUser[winnerSeat?.socketId]` etc., or look up the live socket:
   `io.sockets.sockets.get(sid)?.userId`). Confirm which is reliable and use it.
4. `antiCheat.onJoinTable(socket.id, tableId, seats)` (~738) — pass `socket.userId`. The
   `seats` array for IP-collision still uses socketId (live connections) — keep that.
5. `antiCheat.setPlayerStack(socket.id, ...)` (~781) → key by userId; pass `socket.userId`.
6. `antiCheat.onLeaveTable(socket.id)` (~365, ~1454) → pass `socket.userId`.
7. `antiCheat.onDisconnect(socket.id)` (~1455) → pass `socket.userId`. See disconnect
   semantics below — it must NOT delete accumulated user state anymore.
8. `antiCheat.onChat(socket.id, message)` (~887) → pass `socket.userId`.

If any call site has no `socket.userId` in scope, use the socket object available there.
Report any site where userId genuinely can't be obtained.

## antiCheat.js changes

### Storage re-keying
- `sessions`, `flagged`, `collusionGraph` → keyed by `userId`.
- Add `const socketToUser = {};` and `const userSockets = {};` (userId → Set<socketId>,
  for finding a player's live connections when alerting).
- `actionBuckets`, `ipMap`, `fpMap` stay socketId-keyed (per-connection). Comment why.

### getSession(userId)
Rename conceptually to operate on userId. Store `userId` on the session object. Keep a
`name` field (latest known display name) for readability in alerts/dashboard, but NEVER use
`name` as a lookup key.

### alert(userId, type, severity, detail, data)
- Key `flagged` by userId.
- `antiCheat.emit('alert', a)` — the alert object should include `userId` AND a
  `socketIds` array (current live sockets for that user from `userSockets`) so the server
  can target the player. Keep `playerName` for display.
- Suspicion score accumulates on the userId session.

### Each detection function
Change signatures from `(socketId, ...)` to `(userId, ...)`. Internally use the userId
session. Where a detection needs to alert or act on *live connections* (e.g. blocking),
resolve userId → socketIds via `userSockets`.

Specific care:
- **collusionGraph**: key by userId, not playerName. `updateCollusionGraph(winnerUserId,
  loserUserId, amount)`. Store display names separately for dashboard readout. This closes
  the rename-evasion hole. `analyzeCollusionGraph` walks userId nodes; when it needs to
  alert the other party, resolve their live sockets via `userSockets`.
- **checkChipDump**: keyed by loser userId; `handResults` accumulate on the user.
- **checkIPCollision**: still operates on a live seat list (socketIds) — it's about who's
  concurrently at a table. Resolve each seat's userId via `socketToUser` for the alert,
  but the detection itself is fine on live connections. A player at a table under two
  browser tabs = two sockets, one userId: do NOT flag a single userId sharing an IP with
  *itself*. Add that guard (dedupe by userId before counting).

### onConnect(socketId, userId, playerName, ip, fingerprint)
- If `!userId`: this is a guest. Register the socket for velocity/IP-collision purposes if
  you want, but do NOT create a userId session or accumulate. Return `{ blocked:false }`.
  (Guests can't reach money tables anyway.) Actually simplest: still run the ban checks
  (IP/name/fingerprint bans should block guests too), but skip stat accumulation. Keep ban
  checks; skip session stat creation for guests.
- For authed users: set `socketToUser[socketId] = userId`; add socket to
  `userSockets[userId]`. Load-or-create the userId session. Run existing ban + multi-account
  checks (multi-account IP check should now dedupe by userId — same user reconnecting isn't
  a second account).

### onDisconnect(socketId, userId)
- Remove socket from `userSockets[userId]` and `socketToUser`.
- Clean per-connection ephemeral state (`actionBuckets[socketId]`, remove from
  `ipMap`/`fpMap`).
- **Do NOT delete `sessions[userId]` or `flagged[userId]`.** Accumulated evidence must
  survive disconnect. (It will still be lost on process restart until refactor #2 adds DB
  persistence — that's expected and fine for now.)
- Optional: if `userSockets[userId]` is now empty, you may mark the session idle, but keep
  its data.

### Public API / dashboard
- `getPlayerReport`, `getAlerts({... socketId ...})`, `reviewAlert`, `getDashboard`,
  `setPlayerStack` — update to userId. Where the admin API currently accepts `socketId`,
  accept `userId` instead (check server.js admin routes / adminRoutes.js for callers and
  update them; report what you find).
- `suspicionLeaderboard` and `collusionGraph` dashboard readouts: key by userId, display
  by name.

## Verify

1. `grep -n "socketId" src/antiCheat.js` — remaining uses should ONLY be: the socket→user
   map, `userSockets`/`socketToUser`, `actionBuckets`, `ipMap`/`fpMap`, and function params
   that genuinely handle live connections. No accumulation structure keyed by socketId.
2. `node --check src/antiCheat.js src/server.js`.
3. Trace: a player acts 30 times, disconnects, reconnects (new socketId), acts 60 more.
   Their session should show 90 actions total and stats analysis should fire — NOT reset to
   0 on reconnect. Confirm by reading the code path.
4. Confirm guests (no userId) never create sessions and never crash any anti-cheat call.
5. Confirm admin dashboard/report callers in server.js + adminRoutes.js updated to userId.

Commit as ONE commit: `refactor(anticheat): key player state on userId so evidence survives reconnects`

## Tripwires
- If any anti-cheat call site in server.js has no access to userId, STOP and report it
  rather than guessing.
- If adminRoutes.js references alerts/players by socketId in a way that can't cleanly map
  to userId, STOP and report — don't break the admin console.
- If re-keying collusionGraph by userId breaks the `onHandResult` winner/loser wiring
  (because seats carry socketId not userId), STOP and report how winner/loser userId is
  best obtained before proceeding.
- Do NOT add DB persistence in this commit (that's #2). Do NOT change detection thresholds
  or add new detections. Scope is strictly re-keying.
