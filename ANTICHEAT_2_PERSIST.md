# Anti-Cheat Refactor #2 of 4 — Persist bans + alerts to Postgres

## The problem this fixes

Two durability holes:
1. **Bans** are written to a JSON file. On Railway the path is `/tmp/rfdata/bans.json`, and
   `/tmp` is ephemeral — wiped on every deploy/restart. So the ban list evaporates roughly
   daily. Ban evasion is trivial: wait for the next deploy.
2. **Alerts** (`flagged`) live only in memory. Every restart wipes the entire alert history
   the admin review workflow depends on.

This refactor moves both into Postgres. Depends on refactor #1 (userId keying) being done —
alerts are now keyed by userId, so they persist per account.

## Design decisions (follow exactly)

- **Keep in-memory structures as the hot path.** `bannedIPs/bannedNames/bannedFPs` Sets and
  the `flagged` object stay as the live working copy for fast lookups. Postgres is the
  durable backing store: load into memory at boot, write through on every change.
- **Bans: write-through.** On ban/unban, update the in-memory Set AND upsert/delete the DB
  row synchronously (await). Load all bans into the Sets at boot.
- **Alerts: async write-behind.** On `alert()`, push to in-memory `flagged` (unchanged) AND
  fire a non-blocking INSERT (`.catch` logged, never throws into detection logic). Alerts
  are high-volume and non-critical-path; a failed alert write must never break gameplay or
  detection. Load recent unreviewed alerts into `flagged` at boot so the admin console has
  history after a restart.
- **`reviewAlert` write-through.** Marking an alert reviewed updates memory AND the DB row.
- **No filesystem.** Remove the `fs`/`path` ban-file code entirely.

## Schema — add to db.js initDB (alongside other CREATE TABLE IF NOT EXISTS)

```sql
CREATE TABLE IF NOT EXISTS ac_bans (
  id         SERIAL PRIMARY KEY,
  ban_type   TEXT NOT NULL,          -- 'ip' | 'name' | 'fp'
  value      TEXT NOT NULL,          -- the ip / lowercased name / fingerprint
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (ban_type, value)
);

CREATE TABLE IF NOT EXISTS ac_alerts (
  id            TEXT PRIMARY KEY,     -- the alert's existing generated id
  user_id       TEXT,
  player_name   TEXT,
  type          TEXT NOT NULL,
  severity      INT NOT NULL,
  severity_name TEXT,
  detail        TEXT,
  data          JSONB,
  reviewed      BOOLEAN DEFAULT FALSE,
  action        TEXT,
  admin_note    TEXT,
  ts            BIGINT NOT NULL,      -- keep the ms epoch the code already uses
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ac_alerts_user     ON ac_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_ac_alerts_reviewed ON ac_alerts(reviewed);
CREATE INDEX IF NOT EXISTS idx_ac_alerts_severity ON ac_alerts(severity);
```

Match the exact style of the existing initDB CREATE statements. If `users.id` is not TEXT,
match its type for `user_id`.

## antiCheat.js changes

### Remove filesystem ban code
Delete: the `fs`/`path` requires (if used only here), `DATA_DIR`, `BANS_FILE`, the
`fs.mkdirSync`, `_loadBans`, `_saveBans`, and the `_loadBans()` call at init. The Sets
`bannedIPs/bannedNames/bannedFPs` now start empty and are filled by an async loader.

Add `const db = require('./db');` at top.

### Bans → DB write-through
Replace the ban admin methods:

```js
antiCheat.banIP = async (ip, reason='') => {
  bannedIPs.add(ip);
  await _persistBan('ip', ip, reason);
};
antiCheat.banName = async (name, reason='') => {
  const n = name.toLowerCase();
  bannedNames.add(n);
  await _persistBan('name', n, reason);
};
antiCheat.banFP = async (fp, reason='') => {
  bannedFPs.add(fp);
  await _persistBan('fp', fp, reason);
};
antiCheat.unbanIP = async (ip) => { bannedIPs.delete(ip); await _removeBan('ip', ip); };
antiCheat.unbanName = async (name) => { const n=name.toLowerCase(); bannedNames.delete(n); await _removeBan('name', n); };
antiCheat.unbanFP = async (fp) => { bannedFPs.delete(fp); await _removeBan('fp', fp); };

async function _persistBan(type, value, reason) {
  if (!db.getPool()) return;
  try {
    await db.query(
      `INSERT INTO ac_bans (ban_type, value, reason) VALUES ($1,$2,$3)
       ON CONFLICT (ban_type, value) DO NOTHING`, [type, value, reason]);
  } catch (e) { console.error('[AntiCheat] persistBan failed:', e.message); }
}
async function _removeBan(type, value) {
  if (!db.getPool()) return;
  try {
    await db.query(`DELETE FROM ac_bans WHERE ban_type=$1 AND value=$2`, [type, value]);
  } catch (e) { console.error('[AntiCheat] removeBan failed:', e.message); }
}
```

NOTE: the ban methods are now `async`. CHECK every caller in server.js and adminRoutes.js —
if a route calls `antiCheat.banName(...)`, it should `await` it (or the route handler should
be async). Update callers to await. Report the call sites you changed.

### Boot loader for bans
Add and export:

```js
antiCheat.loadBansFromDB = async () => {
  if (!db.getPool()) return;
  try {
    const { rows } = await db.query(`SELECT ban_type, value FROM ac_bans`);
    for (const r of rows) {
      if (r.ban_type === 'ip')   bannedIPs.add(r.value);
      if (r.ban_type === 'name') bannedNames.add(r.value);
      if (r.ban_type === 'fp')   bannedFPs.add(r.value);
    }
    console.log(`[AntiCheat] Loaded ${rows.length} bans from DB.`);
  } catch (e) { console.error('[AntiCheat] loadBans failed:', e.message); }
};
```

### Alerts → async write-behind
In the `alert()` function, after building the alert object `a` and pushing to
`flagged[userId]` (existing behavior), add a fire-and-forget DB insert:

```js
if (db.getPool()) {
  db.query(
    `INSERT INTO ac_alerts (id,user_id,player_name,type,severity,severity_name,detail,data,reviewed,ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
    [a.id, userId ?? null, a.playerName, a.type, a.severity, a.severityName,
     a.detail, JSON.stringify(a.data||{}), false, a.ts]
  ).catch(e => console.error('[AntiCheat] alert insert failed:', e.message));
}
```

Do NOT await this — detection must not block on DB. Keep the existing in-memory push and the
100-alert-per-user cap unchanged.

### reviewAlert → write-through
In `reviewAlert(alertId, action, note)`, after updating the in-memory alert, add:

```js
if (db.getPool()) {
  db.query(`UPDATE ac_alerts SET reviewed=true, action=$1, admin_note=$2 WHERE id=$3`,
    [action, note, alertId]).catch(e => console.error('[AntiCheat] reviewAlert persist failed:', e.message));
}
```

### Boot loader for recent alerts
Add and export a loader that repopulates `flagged` with recent unreviewed alerts so the admin
console isn't blank after restart:

```js
antiCheat.loadAlertsFromDB = async () => {
  if (!db.getPool()) return;
  try {
    // Last 7 days of unreviewed alerts, cap generous but bounded.
    const { rows } = await db.query(
      `SELECT * FROM ac_alerts WHERE reviewed=false AND ts > $1 ORDER BY ts DESC LIMIT 5000`,
      [Date.now() - 7*24*3600*1000]);
    for (const r of rows) {
      const a = {
        id:r.id, socketId:null, userId:r.user_id, playerName:r.player_name,
        type:r.type, severity:r.severity, severityName:r.severity_name,
        detail:r.detail, data:r.data||{}, ts:Number(r.ts),
        reviewed:r.reviewed, action:r.action, adminNote:r.admin_note,
      };
      if (!flagged[r.user_id]) flagged[r.user_id] = [];
      flagged[r.user_id].push(a);
    }
    // Re-sort each user's alerts oldest→newest to match runtime ordering, and
    // re-apply the 100-cap per user.
    for (const uid of Object.keys(flagged)) {
      flagged[uid].sort((x,y)=>x.ts-y.ts);
      if (flagged[uid].length > 100) flagged[uid] = flagged[uid].slice(-100);
    }
    console.log(`[AntiCheat] Loaded ${rows.length} unreviewed alerts from DB.`);
  } catch (e) { console.error('[AntiCheat] loadAlerts failed:', e.message); }
};
```

## server.js boot wiring

In the boot sequence (the `initAuth().then(async () => { ... })` block, ~line 2010), after
DB is ready and alongside the other loaders, add:

```js
await antiCheat.loadBansFromDB();
await antiCheat.loadAlertsFromDB();
```

Place them before `server.listen`. Confirm `initDB` (which creates the tables) runs before
this — check whether `initAuth`/`_loadAssetsFromDB` already ensures initDB has run; if
initDB is called elsewhere and might not be complete, ensure the ac tables exist first.
Report the ordering you confirmed.

## Verify

1. No `fs`/filesystem ban code remains in antiCheat.js. `grep -n "BANS_FILE\|_saveBans\|_loadBans\|mkdirSync" src/antiCheat.js` → nothing.
2. `node --check src/antiCheat.js src/db.js src/server.js`.
3. All ban/unban callers in server.js + adminRoutes.js now await the async methods. Grep
   `antiCheat.ban` and `antiCheat.unban` across src/, confirm each is awaited in an async fn.
4. Trace: banName → in-memory Set has it AND an ac_bans row is upserted. Restart (simulate:
   fresh Sets + loadBansFromDB) → the ban is back. Confirm by reading the flow.
5. Trace: an alert fires → flagged[userId] gets it immediately (sync) AND an ac_alerts insert
   is queued (async, non-blocking). A DB failure logs but doesn't throw.

Commit as ONE commit: `feat(anticheat): persist bans + alerts to Postgres (durable across restarts)`

## Tripwires
- If any ban caller can't be made async cleanly (e.g. called from sync context), STOP and
  report — don't leave a ban method half-awaited.
- If initDB is NOT guaranteed to have run before the boot loaders, STOP and report the boot
  ordering rather than risking a query against a missing table.
- Do NOT change alert/detection logic or thresholds. Do NOT change refactor-#1 keying.
- Scope is strictly persistence. No blocking behavior (that's #3), no detector changes (#4).
