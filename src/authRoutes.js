const express = require('express');
const router  = express.Router();
const { register, login, verifyTokenAsync, getUser, getAllUsers, banUser,
        authMiddleware, verifyEmail, resetPassword, updateStats } = require('./auth');
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

module.exports = router;
