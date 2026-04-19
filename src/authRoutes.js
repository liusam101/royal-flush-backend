const express = require('express');
const router  = express.Router();
const { register, login, verifyTokenAsync, getUser, getAllUsers, banUser,
        authMiddleware, verifyEmail, resetPassword, updateStats, updateChips } = require('./auth');
const fs   = require('fs');
const path = require('path');
const { sendVerificationEmail, sendPasswordReset, consumeToken } = require('./email');
const { antiCheat } = require('./antiCheat');

// ── Register ──────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const acCheck = antiCheat.onConnect('reg-'+Date.now(), username, ip);
    if (acCheck.blocked) return res.status(403).json({ error: 'Registration not available.' });
    const result = await register({ username, email, password });
    if (!result.ok) return res.status(400).json({ error: result.error });
    // Send verification email (non-blocking)
    sendVerificationEmail(result.user.id, result.user.email, result.user.username)
      .catch(e => console.error('[Email] Verify send failed:', e.message));
    res.json({ ok: true, token: result.token, user: result.user });
  } catch(e) { console.error('/register:', e); res.status(500).json({ error: 'Server error' }); }
});

// ── Login ─────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const result = await login({ email: req.body.email, password: req.body.password });
    if (!result.ok) return res.status(401).json({ error: result.error });
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

// ── Email verification ────────────────────────────────────────────────────
router.post('/verify-email', async (req, res) => {
  try {
    const result = consumeToken(req.body.token, 'verify');
    if (!result.ok) return res.status(400).json({ error: result.error });
    await verifyEmail(result.userId);
    res.json({ ok: true, message: 'Email verified successfully!' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Resend verification
router.post('/resend-verification', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ ok: true, message: 'Already verified.' });
    await sendVerificationEmail(user.id, user.email, user.username);
    res.json({ ok: true, message: 'Verification email sent.' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Forgot password ───────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    // Find user
    const { getAllUsers: getAll } = require('./auth');
    const users = await getAll();
    const user  = users.find(u => u.email === email.toLowerCase());
    // Always return success (don't reveal if email exists)
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
    const result = consumeToken(token, 'reset');
    if (!result.ok) return res.status(400).json({ error: result.error });
    const reset = await resetPassword(result.userId, password);
    if (!reset.ok) return res.status(400).json({ error: reset.error });
    res.json({ ok: true, message: 'Password reset successfully. You can now log in.' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Stats update (called from server after each hand) ─────────────────────
router.post('/stats', authMiddleware, async (req, res) => {
  try {
    await updateStats(req.user.id, req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

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

router.get('/rg', authMiddleware, (req, res) => {
  try { res.json({ ok: true, rg: rg.getRGStatus(req.user.id) }); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/rg/limits', authMiddleware, (req, res) => {
  try {
    const result = rg.setLimits(req.user.id, req.body);
    res.json(result);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/rg/self-exclude', authMiddleware, (req, res) => {
  try {
    const { days } = req.body; // null = permanent, number = days
    const result = rg.selfExclude(req.user.id, days || null);
    res.json(result);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/rg/cooloff', authMiddleware, (req, res) => {
  try {
    const { hours = 24 } = req.body;
    const result = rg.setCooloff(req.user.id, Math.min(hours, 168)); // max 1 week
    res.json(result);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Social features ──────────────────────────────────────────────────────
const social = require('./socialFeatures');
const { getAllUsers: getAll } = require('./auth');

// Sessions
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

// Achievements
router.get('/achievements', authMiddleware, (req, res) => {
  try { res.json({ ok: true, achievements: social.getUserAchievements(req.user.id) }); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Friends
router.get('/friends', authMiddleware, async (req, res) => {
  try {
    const friendIds = social.getFriends(req.user.id);
    const allUsers  = await getAll();
    const friends   = friendIds.map(id => {
      const u = allUsers.find(u => u.id === id);
      return u ? { id: u.id, username: u.username, stats: u.stats } : null;
    }).filter(Boolean);
    res.json({ ok: true, friends });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/friends/add', authMiddleware, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const allUsers = await getAll();
    const friend   = allUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
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

// Avatar
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

// Avatar batch fetch
router.post('/avatars', async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds required' });
    res.json({ ok: true, avatars: social.getAvatars(userIds.slice(0, 50)) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});


// ── Daily Login Bonus ──────────────────────────────────────────────────────
const _DATA_DIR  = process.env.RAILWAY_ENVIRONMENT
  ? path.join('/tmp', 'rfdata')
  : path.join(__dirname, '../../data');
const BONUS_FILE = path.join(_DATA_DIR, 'daily_bonus.json');
const DAILY_GOLD = 1250; // flat daily Gold Chip bonus

function loadBonus() {
  try { return JSON.parse(fs.readFileSync(BONUS_FILE,'utf8')); } catch(_) { return {}; }
}
function saveBonus(d) {
  try {
    fs.mkdirSync(path.dirname(BONUS_FILE),{recursive:true});
    fs.writeFileSync(BONUS_FILE, JSON.stringify(d,null,2));
  } catch(e) { console.error('[Bonus] save failed:', e.message); }
}

router.get('/daily-bonus/status', authMiddleware, (req, res) => {
  try {
    const data   = loadBonus();
    const record = data[req.user.id] || {};
    const today  = new Date().toDateString();
    const claimed = record.lastDay === today;
    res.json({ ok: true, claimed, reward: DAILY_GOLD });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/daily-bonus/claim', authMiddleware, async (req, res) => {
  try {
    const data   = loadBonus();
    const record = data[req.user.id] || {};
    const today  = new Date().toDateString();
    if (record.lastDay === today) return res.status(400).json({ error: 'Already claimed today' });
    data[req.user.id] = { lastClaim: Date.now(), lastDay: today };
    saveBonus(data);
    await updateChips(req.user.id, 0, DAILY_GOLD).catch(()=>{});
    res.json({ ok: true, reward: DAILY_GOLD });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;

