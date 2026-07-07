# Royal Flush Backend — Security & Correctness Fixes

This is an implementation brief. Work through the tasks in order. Each task lists the
file(s), the current state, and the target state. Do not change unrelated behavior.
After each task, note anything you couldn't complete or that needs a human decision.

Repo: `royal-flush-backend`. All paths below are relative to that repo root.

---

## Task 1 — Remove hardcoded secret fallbacks (CRITICAL)

**Problem:** `ADMIN_SECRET` and `JWT_SECRET` have hardcoded default values used when the
env var is missing. These defaults are in the public repo, so if either env var is unset
in production, anyone can gain admin access or forge auth tokens for any user.

**Do this:**

1. Create a new file `src/config.js` that reads and validates required secrets once at boot:

   ```js
   // src/config.js
   // Central place for required secrets. Fails fast if any are missing in production.
   const isProd = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

   function required(name) {
     const val = process.env[name];
     if (!val) {
       if (isProd) {
         console.error(`[FATAL] ${name} is not set. Refusing to start in production.`);
         process.exit(1);
       }
       console.warn(`[config] ${name} not set — using an ephemeral dev-only value.`);
       // Dev-only random value: changes every restart, never a known constant.
       return require('crypto').randomBytes(32).toString('hex');
     }
     return val;
   }

   module.exports = {
     ADMIN_SECRET: required('ADMIN_SECRET'),
     JWT_SECRET:   required('JWT_SECRET'),
   };
   ```

   Note: the dev fallback is a per-process random value, NOT a fixed string. This means
   local dev still works without env vars, but there is no known constant an attacker can use.

2. In `src/auth.js`:
   - Remove the line that defines `JWT_SECRET` from `process.env.JWT_SECRET || 'rf_jwt_dev_secret_change_in_production'`.
   - Replace with: `const { JWT_SECRET } = require('./config');`
   - Remove the now-redundant `if (!process.env.JWT_SECRET) console.warn(...)` line.
   - Keep exporting `JWT_SECRET` as before if other modules import it.

3. In `src/server.js`:
   - Add `const { ADMIN_SECRET } = require('./config');` near the top imports.
   - Replace every occurrence of `process.env.ADMIN_SECRET || 'rf_admin_2025'` with `ADMIN_SECRET`.
     There are multiple: the `joinAdmin`, `adminCreateTournament`, `adminStartTournament`,
     `adminPauseTournament`, `adminBroadcast`, `adminKickPlayer`, and `adminPushAsset` handlers.
   - Remove the boot-time `if (!process.env.ADMIN_SECRET) console.warn(...)` block near
     `initAuth()` — the config module now handles this.

4. In `src/authRoutes.js`:
   - Add `const { ADMIN_SECRET } = require('./config');` near the top imports.
   - In the `/users` and `/ban` routes, replace `process.env.ADMIN_SECRET || 'rf_admin_2025'`
     with `ADMIN_SECRET`.

5. Grep the whole `src/` tree for the strings `rf_admin_2025` and
   `rf_jwt_dev_secret_change_in_production` and confirm zero remain.

**Acceptance:** No hardcoded secret constants remain anywhere in `src/`. With env vars set,
behavior is unchanged. With them unset in a prod-like environment, the process exits at boot.

---

## Task 2 — Verify Stripe collected the correct amount before crediting (HIGH)

**Problem:** In `src/paymentRoutes.js`, chips are credited based on the package looked up
from `session.metadata.packageId`, without confirming Stripe actually charged that amount.

**Do this:**

1. In the `/webhook` handler, inside the `checkout.session.completed` /
   `payment_status === 'paid'` branch, before calling `creditSession`, add:

   ```js
   if (session.amount_total !== pkg.usd * 100) {
     console.error(`[Webhook] Amount mismatch for session ${session.id}: ` +
       `charged ${session.amount_total}, expected ${pkg.usd * 100}. Skipping credit.`);
     return res.json({ received: true }); // ack so Stripe stops retrying, but do NOT credit
   }
   ```

2. In the `GET /verify/:sessionId` handler, after retrieving the session and confirming
   `payment_status === 'paid'` and the `userId` match, add the same amount check before
   `creditSession`:

   ```js
   if (session.amount_total !== pkg.usd * 100) {
     return res.status(400).json({ error: 'Payment amount mismatch.' });
   }
   ```

**Acceptance:** A session whose `amount_total` does not equal the package price is never credited.

---

## Task 3 — Rate-limit registration (HIGH)

**Problem:** `/register` in `src/authRoutes.js` has no IP rate limit (login does). This
allows mass account creation, which is a cash leak given the free daily RC/gold bonuses.

**Do this:** Mirror the existing login limiter. Near the top of `authRoutes.js` where
`_loginAttempts` is defined, add:

```js
const _registerAttempts = new Map(); // ip → { count, resetAt }
const REGISTER_MAX = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 5 accounts per IP per hour
```

At the start of the `/register` handler (after computing `ip`), add:

```js
const now = Date.now();
let rAtt = _registerAttempts.get(ip);
if (!rAtt || now > rAtt.resetAt) rAtt = { count: 0, resetAt: now + REGISTER_WINDOW_MS };
if (rAtt.count >= REGISTER_MAX)
  return res.status(429).json({ error: 'Too many accounts created from this network. Try again later.' });
rAtt.count++;
_registerAttempts.set(ip, rAtt);
```

**Note for reviewer:** In-memory limiter resets on restart and isn't shared across multiple
Railway instances. Acceptable for now; if you scale horizontally, move this to the DB or Redis.

**Acceptance:** The 6th registration attempt from one IP within an hour returns HTTP 429.

---

## Task 4 — Strengthen password requirements (HIGH)

**Problem:** `validate()` in `src/auth.js` requires only 6 characters.

**Do this:** In `validate()`, change the password check to require at least 8 characters:

```js
if (!password || password.length < 8)
  return 'Password must be at least 8 characters.';
```

Also update the same 6-character check in `resetPassword()` in `src/auth.js` to 8, and the
matching client-side hint in the frontend if one exists.

**Optional (flag to human, don't implement without sign-off):** add a HaveIBeenPwned
k-anonymity breach check on registration and reset.

**Acceptance:** Passwords under 8 characters are rejected on both registration and reset.

---

## Task 5 — Fix DB TLS certificate validation (HIGH)

**Problem:** `src/db.js` sets `ssl: { rejectUnauthorized: false }`, disabling cert
validation on the Postgres connection (which carries password hashes and balances).

**This needs a human decision — do NOT just flip the flag.** Present these options:

- **Preferred:** Connect over Railway's private network (internal `*.railway.internal`
  host), which doesn't traverse the public internet and doesn't need SSL. If the app and
  DB are in the same Railway project, switch `DATABASE_URL` to the private URL and set
  `ssl: false`.
- **If a public connection is required:** obtain the provider's CA certificate and use
  `ssl: { ca: fs.readFileSync(process.env.DB_CA_CERT_PATH), rejectUnauthorized: true }`.

Implement whichever the human selects. Leave a `// TODO` with the chosen approach if
blocked on their input.

**Acceptance:** Cert validation is enabled, OR the connection is confirmed to be on a
private network where it's not needed.

---

## Task 6 — Wrap per-hand chip settlement in a DB transaction (MEDIUM)

**Problem:** In `src/server.js`, the hand-over settlement loops over seats calling
`updateChips` one seat at a time with no transaction. A crash mid-loop leaves a pot
partially distributed.

**Do this:**

1. In `src/db.js`, export a transaction helper:

   ```js
   async function withTransaction(fn) {
     const p = getPool();
     if (!p) throw new Error('No database connection');
     const client = await p.connect();
     try {
       await client.query('BEGIN');
       const result = await fn(client);
       await client.query('COMMIT');
       return result;
     } catch (e) {
       await client.query('ROLLBACK').catch(() => {});
       throw e;
     } finally {
       client.release();
     }
   }
   module.exports = { query, queryOne, initDB, getPool, withTransaction };
   ```

2. This is a larger refactor because `updateChips`/`updateStats` in `auth.js` each open
   their own query. **Flag this to the human before doing the full refactor** — the minimal
   safe version is to batch all of a single hand's chip deltas into one `withTransaction`
   block so they commit atomically. Do not attempt to rewrite the settlement flow's logic,
   only its atomicity. If this can't be done cleanly without behavior changes, stop and
   describe what a correct version would look like rather than guessing.

**Acceptance:** All chip deltas for a single settled hand commit or roll back together.
If blocked, a clear written description of the needed change (no partial refactor left behind).

---

## Task 7 — Cleanup items (LOW — safe to batch)

In `src/server.js`:
- The `sessions` object used in the bot-signature alert (`sessions[socket.id]?.name`) is
  defined lower in the file than its first use. It works via hoisting but is fragile.
  Move the `const sessions = {}` declaration and its `io.on('connection', ...)` handler
  above the main connection handler, or fold that name-tracking into the main handler.

In `src/server.js` CORS / socket config:
- `maxHttpBufferSize: 50 * 1024 * 1024` (50MB) applies to all clients but only admins push
  large assets. Lower the global limit to something small (e.g. 1MB) and, if admin asset
  pushes need more, handle those over an authenticated HTTP endpoint with its own size
  limit rather than the global socket buffer. **Flag to human** — confirm assets aren't
  pushed over sockets by non-admins before lowering.
- `originAllowed` permits `origin === 'null'` (file://). Fine for dev; consider gating it
  behind a non-prod check.

Repo hygiene:
- Confirm `.gitignore` actually contains `.env` (the committed `.gitignore` is currently
  empty). Add `.env` and `node_modules/` to it. The committed `.env` file is empty and
  git history contains no secrets, so no history rewrite is needed — just prevent future
  commits.

**Acceptance:** Each cleanup either done or explicitly deferred with a note.

---

## NOT a code task — flag to the human, do not attempt

**Legal structure of the currency model.** The `PACKAGES` table in `paymentRoutes.js`
sells USD directly for `royal` chips, which are then wagered at cash tables, raked, and
ranked on a net-winnings leaderboard. That is a real-money-gaming pattern, not a compliant
sweepstakes one (where the paid currency has no cash value and the redeemable currency is
never sold directly and always has a free alternative method of entry). This is a
structural/legal issue that a gaming attorney must review before more money flows through
the system. Do not attempt to "fix" this in code — surface it clearly and stop.

---

## Suggested commit order

1. Task 1 (secrets) — smallest, closes the worst hole.
2. Task 2 (payment amount check).
3. Tasks 3 + 4 (register limit + password length) — quick, related.
4. Task 5 (DB TLS) — needs human input first.
5. Task 6 (transaction) — needs human input, larger.
6. Task 7 (cleanup) — batch last.

Commit each task separately with a clear message. Do not combine unrelated changes.
