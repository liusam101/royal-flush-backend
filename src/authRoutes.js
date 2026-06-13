const express = require('express');
const router  = express.Router();
const { register, login, verifyTokenAsync, getUser, getAllUsers, banUser,
        authMiddleware, verifyEmail, setOTP, verifyOTP, resetPassword, updateStats, updateChips } = require('./auth');
const crypto = require('crypto');
const { query: dbQuery, queryOne } = require('./db');
const { sendVerificationEmail, sendOTPEmail, sendPasswordReset, consumeToken } = require('./email');

function generateOTP() {
  // cryptographically random 6-digit code
  return String(100000 + (crypto.randomBytes(3).readUIntBE(0, 3) % 900000));
}
const { antiCheat } = require('./antiCheat');

const _otpCooldown  = new Map(); // userId → timestamp of last send
const _otpAttempts  = new Map(); // userId → { count, resetAt } — brute-force guard
const OTP_MAX_TRIES = 10;
const OTP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes (matches OTP TTL)

const _loginAttempts = new Map(); // ip → { count, resetAt } — brute-force guard
const LOGIN_MAX_TRIES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// ── Register ──────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const acCheck = antiCheat.onConnect('reg-'+Date.now(), username, ip);
    if (acCheck.blocked) return res.status(403).json({ error: 'Registration not available.' });
    const result = await register({ username, email, password });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, token: result.token, user: result.user });
    setImmediate(async () => {
      try {
        const code = generateOTP();
        await setOTP(result.user.id, code);
        await sendOTPEmail(result.user.id, result.user.email, result.user.username, code);
      } catch(e) { console.error('[Email] OTP send failed:', e.message); }
    });
  } catch(e) { console.error('/register:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── Login ─────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const now = Date.now();
    let att = _loginAttempts.get(ip);
    if (!att || now > att.resetAt) att = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    if (att.count >= LOGIN_MAX_TRIES)
      return res.status(429).json({ error: 'Too many login attempts. Please try again in 15 minutes.' });

    const result = await login({ email: req.body.email, password: req.body.password });
    if (!result.ok) {
      att.count++;
      _loginAttempts.set(ip, att);
      return res.status(401).json({ error: result.error });
    }
    _loginAttempts.delete(ip); // clear on success
    res.json({ ok: true, token: result.token, user: result.user });
  } catch(e) { console.error('/login:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── Verify token ──────────────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  try {
    const user = await verifyTokenAsync(req.body.token);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid token' });
    res.json({ ok: true, user });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Me ────────────────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Email verification (link-based — legacy fallback) ─────────────────────
router.post('/verify-email', async (req, res) => {
  try {
    const result = await consumeToken(req.body.token, 'verify');
    if (!result.ok) return res.status(400).json({ error: result.error });
    await verifyEmail(result.userId);
    res.json({ ok: true, message: 'Email verified successfully!' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── OTP verification ──────────────────────────────────────────────────────
router.post('/verify-otp', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter a 6-digit code.' });

    // Brute-force guard: max 10 attempts per OTP window
    const now = Date.now();
    let att = _otpAttempts.get(req.user.id);
    if (!att || now > att.resetAt) att = { count: 0, resetAt: now + OTP_WINDOW_MS };
    if (att.count >= OTP_MAX_TRIES) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
    }
    att.count++;
    _otpAttempts.set(req.user.id, att);

    const result = await verifyOTP(req.user.id, code);
    if (!result.ok) return res.status(400).json({ error: result.error });
    _otpAttempts.delete(req.user.id); // clear on success
    res.json({ ok: true, message: 'Email verified!' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Resend verification (OTP) ─────────────────────────────────────────────
router.post('/resend-verification', authMiddleware, async (req, res) => {
  try {
    const last = _otpCooldown.get(req.user.id) || 0;
    if (Date.now() - last < 60_000)
      return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code.' });
    _otpCooldown.set(req.user.id, Date.now());
    const user = await getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ ok: true, message: 'Already verified.' });
    const code = generateOTP();
    await setOTP(user.id, code);
    await sendOTPEmail(user.id, user.email, user.username, code);
    res.json({ ok: true, message: 'A new verification code has been sent to your email.' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Forgot password ───────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    // Direct indexed query — no full table scan
    const user = await queryOne(
      'SELECT id, email, username FROM users WHERE email=$1 AND banned=false',
      [email.toLowerCase()]
    );
    if (user) {
      await sendPasswordReset(user.id, user.email, user.username);
    }
    res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
  } catch(e) { console.error('/forgot-password:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── Reset password ────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required.' });
    const result = await consumeToken(token, 'reset');
    if (!result.ok) return res.status(400).json({ error: result.error });
    const reset = await resetPassword(result.userId, password);
    if (!reset.ok) return res.status(400).json({ error: reset.error });
    res.json({ ok: true, message: 'Password reset successfully. You can now log in.' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Stats are updated server-side only (after each hand in server.js).
// A public endpoint would allow any user to forge their own leaderboard stats.

// ── Admin ─────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== (process.env.ADMIN_SECRET || 'rf_admin_2025'))
    return res.status(401).json({ error: 'Unauthorized' });
  try { res.json(await getAllUsers()); } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/ban', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== (process.env.ADMIN_SECRET || 'rf_admin_2025'))
    return res.status(401).json({ error: 'Unauthorized' });
  try { res.json({ ok: await banUser(req.body.userId) }); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Responsible Gambling ────────────────────────────────────────────────────
const rg = require('./responsibleGambling');

router.get('/rg', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, rg: await rg.getRGStatus(req.user.id) }); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/rg/limits', authMiddleware, async (req, res) => {
  try {
    const result = await rg.setLimits(req.user.id, req.body);
    res.json(result);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/rg/self-exclude', authMiddleware, async (req, res) => {
  try {
    const { days } = req.body;
    const result = await rg.selfExclude(req.user.id, days || null);
    res.json(result);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/rg/cooloff', authMiddleware, async (req, res) => {
  try {
    const { hours = 24 } = req.body;
    const result = await rg.setCooloff(req.user.id, Math.min(hours, 168));
    res.json(result);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Social features ──────────────────────────────────────────────────────
const social = require('./socialFeatures');

router.get('/sessions', authMiddleware, (req, res) => {
  try { res.json({ ok: true, sessions: social.getUserSessions(req.user.id) }); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/sessions/start', authMiddleware, (req, res) => {
  try {
    const id = social.startUserSession(req.user.id, req.body);
    res.json({ ok: true, sessionId: id });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/sessions/end', authMiddleware, (req, res) => {
  try {
    social.endUserSession(req.user.id, req.body.sessionId, req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/achievements', authMiddleware, (req, res) => {
  try { res.json({ ok: true, achievements: social.getUserAchievements(req.user.id) }); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Friends ──────────────────────────────────────────────────────────────
router.get('/friends', authMiddleware, async (req, res) => {
  try {
    const friendIds = social.getFriends(req.user.id);
    if (!friendIds.length) return res.json({ ok: true, friends: [] });
    // Targeted query — only fetch the specific friend users, not all users
    const rows = await dbQuery(
      `SELECT id, username, hands_played, total_won, total_lost, hands_won FROM users
       WHERE id = ANY($1) AND banned=false`,
      [friendIds]
    );
    const friends = rows.map(u => ({
      id: u.id, username: u.username,
      stats: { handsPlayed: parseInt(u.hands_played||0), handsWon: parseInt(u.hands_won||0),
               totalWon: parseFloat(u.total_won||0), totalLost: parseFloat(u.total_lost||0) },
    }));
    res.json({ ok: true, friends });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/friends/add', authMiddleware, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    // Direct indexed lookup — no full table scan
    const friend = await queryOne(
      'SELECT id, username FROM users WHERE LOWER(username)=LOWER($1) AND banned=false', [username]
    );
    if (!friend) return res.status(404).json({ error: 'Player not found' });
    if (friend.id === req.user.id) return res.status(400).json({ error: "Can't add yourself" });
    const result = social.addFriend(req.user.id, friend.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, friend: { id: friend.id, username: friend.username } });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/friends/remove', authMiddleware, async (req, res) => {
  try {
    const { friendId } = req.body;
    social.removeFriend(req.user.id, friendId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Avatar ───────────────────────────────────────────────────────────────
router.post('/avatar', authMiddleware, (req, res) => {
  try {
    const { image } = req.body;
    const result = social.saveAvatar(req.user.id, image);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/avatar/:userId', async (req, res) => {
  try {
    const avatar = social.getAvatar(req.params.userId);
    res.json({ ok: true, avatar });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/avatars', async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds required' });
    res.json({ ok: true, avatars: social.getAvatars(userIds.slice(0, 50)) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});


// ── Daily Login Bonus ──────────────────────────────────────────────────────
const DAILY_GOLD = 1250;

router.get('/daily-bonus/status', authMiddleware, async (req, res) => {
  try {
    const row = await queryOne('SELECT last_bonus_day FROM users WHERE id = $1', [req.user.id]);
    const today = new Date().toISOString().slice(0, 10); // UTC date — consistent across timezones
    const claimed = row?.last_bonus_day === today;
    res.json({ ok: true, claimed, reward: DAILY_GOLD });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/daily-bonus/claim', authMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10); // UTC date — consistent across timezones
    // Atomic update — prevents double-claim from race conditions
    const rows = await dbQuery(
      'UPDATE users SET last_bonus_day=$1 WHERE id=$2 AND (last_bonus_day IS DISTINCT FROM $1) RETURNING id',
      [today, req.user.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Already claimed today' });
    await updateChips(req.user.id, 0, DAILY_GOLD).catch(()=>{});
    res.json({ ok: true, reward: DAILY_GOLD });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Public leaderboard (no auth required) ──────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT username, total_won, total_lost, hands_played
       FROM users
       WHERE banned=false AND hands_played > 0
       ORDER BY (COALESCE(total_won,0) - COALESCE(total_lost,0)) DESC
       LIMIT 10`
    );
    const leaders = rows.map(u => ({
      name:  u.username,
      net:   parseFloat(u.total_won || 0) - parseFloat(u.total_lost || 0),
      hands: parseInt(u.hands_played || 0),
    }));
    res.json({ ok: true, leaders });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── RC daily claim (Barrel Chip — persists balance to DB) ─────────────────
const RC_DAILY_CHIPS = 1; // $1 RC value

router.post('/rc-claim', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    // Atomic DB update — same pattern as daily-bonus/claim.
    // Rejects if last_rc_day already equals today, preventing double-claims
    // even across server restarts or multiple Railway instances.
    const rows = await dbQuery(
      'UPDATE users SET last_rc_day=$1 WHERE id=$2 AND (last_rc_day IS DISTINCT FROM $1) RETURNING id',
      [today, req.user.id]
    );
    if (!rows.length) return res.status(429).json({ error: 'Already claimed today.' });
    await updateChips(req.user.id, RC_DAILY_CHIPS, 0);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
