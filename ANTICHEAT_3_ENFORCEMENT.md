# Anti-Cheat Refactor #3 of 4 — Wire enforcement to unambiguous CRITICAL alerts

## The problem this fixes

Detection currently has no teeth. The `antiCheat.on('alert', ...)` listener only streams to
the admin room and logs — even a CRITICAL banned-device or ban-evasion hit lets the player
keep playing until a human manually reviews. This refactor makes the small set of
UNAMBIGUOUS critical signals take automatic action, while leaving everything statistical
(collusion scores, timing, chip-dump patterns) as advisory-only for human review.

Depends on refactors #1 (userId keying) and #2 (persistence) being done.

## Core principle — only auto-act on signals that are near-zero false-positive

Auto-enforcement is ONLY for signals that are essentially deterministic:
- `BANNED_DEVICE`, `BAN_EVASION_IP`, `BAN_EVASION_NAME` — the player matches an existing
  ban. This is a lookup, not a heuristic. Safe to block.

Everything else — `COLLUSION_RING`, `COLLUSION_GRAPH`, `CHIP_DUMP_*`, `SOLVER_*`,
`BOT_*`, `SUPERHUMAN_*`, `DEVICE_MULTI_ACCOUNT`, `MULTI_ACCOUNT_IP`, `SAME_IP_SAME_TABLE`,
`GHOSTING_RISK`, `RTA_*`, `CHAT_*` — stays ADVISORY. These are statistical and WILL
false-positive (we discussed the fingerprint collisions, fast-human timing, legitimate
same-household IP sharing). Auto-banning on these would punish innocent players and is
worse than the cheating. They generate alerts for human review ONLY. Do not auto-act on them.

The ban-match signals ALREADY block at connect time (onConnect returns `{blocked:true}`).
The gap this fixes: a ban that is applied WHILE a player is already connected/seated, and
making the block include actual removal from tables, not just an error message.

## Changes

### 1. When an admin bans, immediately eject any matching live sessions (server.js)

Today, banning adds to the Set + DB but a currently-seated matching player keeps playing
until they reconnect. Add active ejection.

In antiCheat.js, add a helper that returns the socketIds to eject for a given ban, using the
live maps:

```js
// Returns live socketIds currently matching a ban value, for immediate ejection.
antiCheat.socketsMatchingBan = (type, value) => {
  const out = new Set();
  if (type === 'ip') {
    for (const [sid, uid] of Object.entries(socketToUser)) {
      if (sessions[uid]?.ip === value) out.add(sid);
    }
    if (ipMap[value]) for (const sid of ipMap[value]) out.add(sid);
  } else if (type === 'name') {
    for (const [uid, s] of Object.entries(sessions)) {
      if ((s.name||'').toLowerCase() === value) {
        for (const sid of (userSockets[uid]||[])) out.add(sid);
      }
    }
  } else if (type === 'fp') {
    if (fpMap[value]) for (const sid of fpMap[value]) out.add(sid);
  }
  return [...out];
};
```

In the admin ban route/handler (adminRoutes.js `/anticheat/ban` and/or server.js
`adminKickPlayer` neighbours), AFTER the `await antiCheat.banX(...)` call, eject matches.
Because adminRoutes.js has `req.io`, do:

```js
const socks = antiCheat.socketsMatchingBan(type, value);
for (const sid of socks) {
  req.io?.to(sid).emit('kicked', { reason: 'Account banned' });
  const { affected } = tableManager.removePlayer(sid);   // if tableManager is importable here
  affected?.forEach(tid => req.io?.to(tid).emit('tableState', tableManager.getTableState(tid)));
  req.io?.sockets?.sockets?.get(sid)?.disconnect(true);
}
```

CHECK: is `tableManager` importable in adminRoutes.js? It already imports `tableManager` per
earlier reads (used in `/tables/:tableId/kick`). Reuse that. If the removePlayer signature or
return differs, match the existing `/players/kick` route's pattern exactly — that route
already does kick + removePlayer. Model the ejection on it.

### 2. Auto-enforce ban-match alerts raised mid-session (server.js alert listener)

Extend the `antiCheat.on('alert', ...)` listener. For the three deterministic ban-match
types, eject the offending sockets immediately (belt-and-suspenders with the connect-time
block, catching cases where the ban check fires after seating):

```js
const AUTO_EJECT_TYPES = new Set(['BANNED_DEVICE','BAN_EVASION_IP','BAN_EVASION_NAME']);

antiCheat.on('alert', (alert) => {
  io.to('admin').emit('acAlert', alert);
  if (alert.severity >= antiCheat.SEV.HIGH)
    console.warn(`[AntiCheat] ${alert.severityName} — ${alert.type}: ${alert.detail}`);

  if (AUTO_EJECT_TYPES.has(alert.type) && Array.isArray(alert.socketIds)) {
    for (const sid of alert.socketIds) {
      io.to(sid).emit('kicked', { reason: 'Account banned' });
      const { affected } = tableManager.removePlayer(sid);
      affected?.forEach(tid => io.to(tid).emit('tableState', tableManager.getTableState(tid)));
      io.sockets.sockets.get(sid)?.disconnect(true);
    }
    console.warn(`[AntiCheat] AUTO-EJECT ${alert.type} — ${alert.socketIds.length} socket(s)`);
  }
});
```

NOTE: refactor #1's `alert()` includes a `socketIds` array on the emitted alert. Confirm it's
present; if the field is named differently, use that. If it's absent, resolve via
`userSockets[alert.userId]` — report which you used.

### 3. Persist an account restriction flag on confirmed critical review (server.js / adminRoutes.js)

The `users.banned` column already exists. Wire the admin "ban" action to also set it, so a
banned user can't simply reconnect as the same account (IP/name/fp bans are evadable; the
account flag is not). In the admin ban route, when banning by name and a matching user exists,
also:

```sql
UPDATE users SET banned = true WHERE LOWER(username) = $1
```

And in the auth/login + socket handshake path, CHECK: does login already reject
`banned = true` users? Search auth.js / the JWT handshake. If NOT, add a rejection: a user
row with `banned=true` cannot authenticate (login returns an error; socket handshake does not
set userId / disconnects). REPORT what you find — if banned-account rejection already exists,
just ensure the ban route sets the column; if it doesn't, add the rejection.

### 4. Leave statistical alerts advisory — explicit no-op documentation

Add a comment block above the alert listener enumerating that all non-AUTO_EJECT_TYPES are
advisory/human-review-only BY DESIGN, so no future edit "helpfully" auto-bans on collusion or
timing scores. This is a deliberate anti-false-positive stance.

## What must NOT change
- No auto-action on ANY statistical/heuristic alert type. Only the 3 ban-match types.
- Detection logic, thresholds, scoring — untouched.
- Refactor #1 keying and #2 persistence — untouched.
- Do not invent a redemption/cashout freeze — there is no automated redemption code path in
  this repo (redemptions are handled outside the app). If you find one, STOP and report
  rather than wiring into it.

## Verify
1. `node --check src/server.js src/antiCheat.js src/adminRoutes.js`.
2. Trace: admin bans a name whose owner is seated → `socketsMatchingBan('name', ...)` returns
   their live socket(s) → they're kicked, removed from the table, disconnected → `users.banned`
   set → they cannot re-authenticate.
3. Trace: a `COLLUSION_RING` CRITICAL alert fires → admin room is notified, logged, and NO
   auto-ejection happens (it's not in AUTO_EJECT_TYPES). Confirm.
4. Confirm the three ban-match types eject; confirm nothing else does.
5. Confirm `tableManager` is properly imported wherever ejection code was added.

Commit as ONE commit: `feat(anticheat): auto-eject on ban-match, set account flag; statistical alerts stay advisory`

## Tripwires
- If `users.banned` is already enforced at login, note it and just set the column. If not,
  the added rejection must not break normal login for non-banned users — trace one normal
  login through the new check.
- If `tableManager.removePlayer` isn't safely callable from the alert listener or admin route
  (wrong scope/import), STOP and report.
- If the emitted alert lacks `socketIds` and `userId` both, STOP and report — ejection needs
  a way to resolve live sockets.
- Do NOT broaden AUTO_EJECT_TYPES beyond the 3 deterministic ban-match types, even if it
  seems "safe" — statistical false-positives are the whole risk being avoided.
