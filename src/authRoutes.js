const express = require('express');
const router  = express.Router();
const { register, login, verifyTokenAsync, getUser, getAllUsers, banUser, authMiddleware } = require('./auth');
const { antiCheat } = require('./antiCheat');

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const acCheck = antiCheat.onConnect('reg-'+Date.now(), username, ip);
    if (acCheck.blocked) return res.status(403).json({ error: 'Registration not available.' });
    const result = await register({ username, email, password });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, token: result.token, user: result.user });
  } catch(e) { console.error('/register error:', e); res.status(500).json({ error: 'Server error' }); }
});

router.post('/login', async (req, res) => {
  try {
    const result = await login({ email: req.body.email, password: req.body.password });
    if (!result.ok) return res.status(401).json({ error: result.error });
    res.json({ ok: true, token: result.token, user: result.user });
  } catch(e) { console.error('/login error:', e); res.status(500).json({ error: 'Server error' }); }
});

router.post('/verify', async (req, res) => {
  try {
    const user = await verifyTokenAsync(req.body.token);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid token' });
    res.json({ ok: true, user });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/users', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== (process.env.ADMIN_SECRET || 'rf_admin_2025'))
    return res.status(401).json({ error: 'Unauthorized' });
  try { res.json(await getAllUsers()); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/ban', async (req, res) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== (process.env.ADMIN_SECRET || 'rf_admin_2025'))
    return res.status(401).json({ error: 'Unauthorized' });
  try { res.json({ ok: await banUser(req.body.userId) }); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
