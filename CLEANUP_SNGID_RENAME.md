# Cleanup: disambiguate `sngId` in sngAction (internal rename only, wire unchanged)

## Why

The name `sngId` is used for TWO different things in server.js:
- In the `sngJoin` handler, `sngId` is the SNG **lobby/config id** — correct name, multiple
  tournament instances can match one lobby id (`t.sngId === sngId`). LEAVE THIS AS-IS.
- In the `sngAction` handler, `sngId` is actually the **tournament instance id**: it's used
  as `tournamentEngine.get(sngId)`, `eliminatePlayer(sngId, ...)`, and as `tourn_id` in the
  ledger writes. The frontend sends `_activeSNGTournId` in this field. It's a tournament id
  wearing an SNG-lobby name. This mismatch already cost a debugging cycle (verifying the
  ledger `tourn_id` matched the INSERT's `tourn.id`).

This change renames ONLY the internal variable in the `sngAction` handler, so the code reads
as what it is, WITHOUT changing anything on the wire.

## Constraint — do not break the protocol

The frontend emits `{ sngId: _activeSNGTournId, action, amount }` (index.html ~line 13256).
The incoming socket event field MUST stay named `sngId`. Do not touch the frontend. Do not
change any `emit`/event names. Only the internal JS variable changes, via a destructure alias.

## The change (server.js, sngAction handler only — around lines 570–656)

Change the handler signature from:
```js
socket.on('sngAction', async ({ sngId, action, amount }) => {
  const tourn = tournamentEngine.get(sngId);
```
to:
```js
socket.on('sngAction', async ({ sngId: tournId, action, amount }) => {
  // wire field is 'sngId' for back-compat, but it carries the tournament instance id
  const tourn = tournamentEngine.get(tournId);
```

Then replace every OTHER `sngId` reference INSIDE this handler with `tournId`:
- `tournamentEngine.get(sngId)` → `get(tournId)` (both occurrences, ~571 and ~630)
- `tournamentEngine.eliminatePlayer(sngId, seat.socketId)` → `eliminatePlayer(tournId, ...)`
- the ledger UPDATE params `[elim.prize, sngId, elimSkt.userId]` → `[elim.prize, tournId, elimSkt.userId]`
- the winner ledger params `[wPrize, sngId, wSkt.userId]` → `[wPrize, tournId, wSkt.userId]`
- `io.to('tourn_' + sngId)` → `io.to('tourn_' + tournId)` (both occurrences)
- `tournamentEngine.getState(sngId)` → `getState(tournId)`

Scope strictly to the `sngAction` handler. Do NOT change `sngId` anywhere in the `sngJoin`
handler or any other handler.

## Verify

1. `grep -n "sngId" src/server.js` — the ONLY remaining occurrences should be:
   - everything in the `sngJoin` handler (unchanged), and
   - the `{ sngId: tournId, ... }` destructure line in sngAction (the wire field name).
   No bare `sngId` should remain in the body of sngAction.
2. `node --check src/server.js`.
3. Confirm frontend untouched: `git status` in the frontend repo shows no changes.

Commit (backend only): `refactor: sngAction reads tournId internally (wire field unchanged)`

## Tripwire

- If `sngId` inside sngAction is ever passed to something that genuinely expects the lobby
  id (not the tournament instance id), STOP and report — that would mean the two concepts
  are actually conflated in logic, not just naming.
