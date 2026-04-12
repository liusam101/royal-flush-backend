// ══════════════════════════════════════════════════════════════════
// Admin Routes — protected API for platform management
// ══════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { tableManager }       = require('./tableManager');
const { tournamentEngine }   = require('./tournamentEngine');
const { antiCheat }          = require('./antiCheat');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'rf_admin_2025';

// ── Auth middleware ──────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_SECRET) return res.status(401).json({ error:'Unauthorized' });
  next();
}

// ── Dashboard ────────────────────────────────────────────────────
router.get('/dashboard', auth, (req, res) => {
  const tables  = tableManager.getTableList();
  const tourns  = tournamentEngine.getAll().map(t=>tournamentEngine.getState(t.id));
  const totalPlayers = tables.reduce((a,t)=>a+t.players,0);
  const activeTourns = tourns.filter(t=>t.status==='running').length;
  res.json({
    tables,
    totalPlayers,
    tournaments: tourns,
    activeTournaments: activeTourns,
    serverTime: Date.now(),
  });
});

// ── Tables ───────────────────────────────────────────────────────
router.get('/tables', auth, (req, res) => {
  res.json(tableManager.getTableList().map(t=>({
    ...t, state: tableManager.getTableState(t.id)
  })));
});

router.post('/tables/:tableId/kick', auth, (req, res) => {
  const { socketId } = req.body;
  if (!socketId) return res.status(400).json({ error:'socketId required' });
  tableManager.leaveTable(req.params.tableId, socketId);
  req.io?.to(req.params.tableId).emit('tableState', tableManager.getTableState(req.params.tableId));
  req.io?.to(socketId).emit('kicked', { reason:'Removed by admin' });
  res.json({ ok:true });
});

// ── Tournaments ──────────────────────────────────────────────────
router.get('/tournaments', auth, (req, res) => {
  res.json(tournamentEngine.getAll().map(t=>tournamentEngine.getState(t.id)));
});

router.post('/tournaments', auth, (req, res) => {
  const { name, buyIn, startingStack, blindMins, maxPlayers, guarantee } = req.body;
  if (!name || !buyIn) return res.status(400).json({ error:'name and buyIn required' });
  const t = tournamentEngine.createTournament({ name, buyIn:Number(buyIn), startingStack:Number(startingStack)||5000, blindMins:Number(blindMins)||10, maxPlayers:Number(maxPlayers)||100, guarantee:Number(guarantee)||0 });
  res.json({ ok:true, tournament: tournamentEngine.getState(t.id) });
});

router.post('/tournaments/:id/start', auth, (req, res) => {
  const result = tournamentEngine.start(req.params.id, req.io);
  if (!result.ok) return res.status(400).json(result);
  req.io?.emit('tournStarted', tournamentEngine.getState(req.params.id));
  res.json({ ok:true, ...result });
});

router.post('/tournaments/:id/pause', auth, (req, res) => {
  tournamentEngine.pause(req.params.id);
  req.io?.emit('tournPaused', { id:req.params.id });
  res.json({ ok:true });
});

router.post('/tournaments/:id/resume', auth, (req, res) => {
  tournamentEngine.resume(req.params.id, req.io);
  req.io?.emit('tournResumed', { id:req.params.id });
  res.json({ ok:true });
});

router.post('/tournaments/:id/cancel', auth, (req, res) => {
  tournamentEngine.cancel(req.params.id);
  req.io?.emit('tournCancelled', { id:req.params.id });
  res.json({ ok:true });
});

router.delete('/tournaments/:id', auth, (req, res) => {
  tournamentEngine.delete(req.params.id);
  res.json({ ok:true });
});

// ── Player management ────────────────────────────────────────────
router.post('/players/kick', auth, (req, res) => {
  const { socketId, reason } = req.body;
  req.io?.to(socketId).emit('kicked', { reason: reason||'Removed by admin' });
  // Remove from all tables
  const affected = tableManager.removePlayer(socketId);
  affected.forEach(tid=>req.io?.to(tid).emit('tableState', tableManager.getTableState(tid)));
  res.json({ ok:true, tablesAffected:affected });
});

router.post('/players/message', auth, (req, res) => {
  const { socketId, message } = req.body;
  req.io?.to(socketId).emit('adminMessage', { message });
  res.json({ ok:true });
});

router.post('/players/broadcast', auth, (req, res) => {
  const { message } = req.body;
  req.io?.emit('adminBroadcast', { message });
  res.json({ ok:true });
});

// ── Hand History ─────────────────────────────────────────────────────────────
const handHistory = require('./handHistory');

router.get('/hands', auth, (req, res) => {
  const { player, table, limit=50 } = req.query;
  if (player) return res.json(handHistory.getPlayerHands(player, parseInt(limit)));
  if (table)  return res.json(handHistory.getTableHands(table, parseInt(limit)));
  res.json(handHistory.getRecentHands(parseInt(limit)));
});

router.get('/hands/stats', auth, (req, res) => {
  res.json(handHistory.getStats());
});

router.get('/hands/:handId', auth, (req, res) => {
  const hand = handHistory.getHand(req.params.handId);
  if (!hand) return res.status(404).json({ error: 'Hand not found' });
  res.json(hand);
});

router.get('/hands/:handId/replay', auth, (req, res) => {
  const replay = handHistory.replayHand(req.params.handId);
  if (!replay) return res.status(404).json({ error: 'Hand not found' });
  res.json(replay);
});

// ── Anti-Cheat ──────────────────────────────────────────────────────────────
router.get('/anticheat', auth, (req, res) => {
  res.json(antiCheat.getDashboard());
});

router.get('/anticheat/alerts', auth, (req, res) => {
  const { severity=1, unreviewed } = req.query;
  res.json(antiCheat.getAlerts({
    minSeverity: parseInt(severity),
    unreviewed: unreviewed === 'true',
  }));
});

router.get('/anticheat/player/:socketId', auth, (req, res) => {
  res.json(antiCheat.getPlayerReport(req.params.socketId));
});

router.post('/anticheat/alerts/:alertId/review', auth, (req, res) => {
  const { action, note } = req.body;
  const alert = antiCheat.reviewAlert(req.params.alertId, action, note);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json({ ok: true, alert });
});

router.post('/anticheat/ban', auth, (req, res) => {
  const { type, value, reason } = req.body; // type: 'ip'|'name'
  if (type === 'ip')   antiCheat.banIP(value);
  if (type === 'name') antiCheat.banName(value);
  res.json({ ok: true, banned: { type, value, reason } });
});

router.delete('/anticheat/ban', auth, (req, res) => {
  const { type, value } = req.body;
  if (type === 'ip')   antiCheat.unbanIP(value);
  if (type === 'name') antiCheat.unbanName(value);
  res.json({ ok: true });
});

module.exports = router;
