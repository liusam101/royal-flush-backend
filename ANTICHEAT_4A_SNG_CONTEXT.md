# Anti-Cheat Refactor #4a — Pass detection context on the SNG action path

## The problem

The cash-table `playerAction` handler passes a context object to `antiCheat.onAction`
(potSize, stackSize, isPreflop) that drives timing analysis, ghosting detection, and
VPIP/PFR tracking. The SNG handler (`sngAction`) passes NO context — so for all tournament
play, ghosting and preflop-stat tracking silently don't run, and timing runs without pot
context. Tournament play is effectively unmonitored for those detectors. This adds the same
context the cash path already supplies.

Small, self-contained. Depends on refactors #1–3 (already done).

## The change (server.js, sngAction handler ~line 1282)

The SNG handler already resolves `tableId` from `player.tableId`. Before the `onAction`
call, fetch the pre-action table state (same as the cash path does) and pass the context.

Current:
```js
    const tableId = player.tableId;

    // SNG path currently passes no ctx (that's refactor #4); add userId now.
    const acOk = antiCheat.onAction(socket.id, socket.userId, action, tableId);
    if (acOk === false) { socket.emit('error', { message: 'Action rate limited' }); return; }
```

Change to:
```js
    const tableId = player.tableId;

    const preState = tableManager.getTableState(tableId);
    const mySeat   = preState?.seats?.find(s => s.socketId === socket.id);
    const acOk = antiCheat.onAction(socket.id, socket.userId, action, tableId, {
      potSize:   preState?.pot || 0,
      stackSize: mySeat?.stack || 0,
      isPreflop: preState?.phase === 'preflop',
    });
    if (acOk === false) { socket.emit('error', { message: 'Action rate limited' }); return; }
```

## Also check: isFirstAction

The cash path's context does NOT set `isFirstAction`, but antiCheat's VPIP tracking gates on
`ctx.isPreflop && ctx.isFirstAction` (in `onAction`). CHECK how the cash path handles this —
if the cash path also omits `isFirstAction`, then VPIP tracking is currently a no-op on BOTH
paths (a pre-existing gap, not something to fix here). REPORT what you find:
- If `isFirstAction` is never set anywhere, note that VPIP/PFR stats are effectively dead on
  both paths — that's a detector-quality issue for the collusion/stats brief, NOT this one.
  Do not try to fix it here; just report it so it's tracked.
- If the cash path sets it somewhere I missed, mirror that on the SNG path too.

Keep this change strictly to reaching parity with the cash path's existing context. Do not
add new fields the cash path doesn't have.

## Verify
1. `node --check src/server.js`.
2. The SNG `onAction` call now passes the same 3-field ctx object the cash path passes.
3. Confirm `tableManager` and `preState` are correctly in scope at that point (they are —
   tableId is already derived from tableManager state just above).
4. Report the `isFirstAction` finding.

Commit as ONE commit: `fix(anticheat): pass timing/ghosting/stat context on SNG action path`

## Tripwire
- If fetching `getTableState` here would double-fetch or conflict with a state fetch already
  happening later in the handler, consolidate to one fetch and report — don't fetch twice.
- If anything about the SNG handler's structure differs from the cash path in a way that makes
  the context values wrong (e.g. pot/stack meaning differently in tournament state), STOP and
  report.
