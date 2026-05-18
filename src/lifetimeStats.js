// ════════════════════════════════════════════════════════════════════
// LIFETIME STATS ENDPOINT — Royal Flush backend (PostgreSQL)
// ════════════════════════════════════════════════════════════════════
//
// Adds GET /api/stats/lifetime which returns site-wide totals for the
// frontend homepage stats bar. Cached 60s server-side to avoid DB load.
//
// PASTE INSTRUCTIONS (server.js):
//   1. Near top, add the require:
//        const lifetimeStats = require('./lifetimeStats');
//   2. After the other routes (e.g. after app.use('/api/auth', authRouter)):
//        app.use('/', lifetimeStats);
// ════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const { query, getPool } = require('./db');

let _cache = { data: null, expiresAt: 0 };
const TTL_MS = 60 * 1000; // 60s cache

router.get('/api/stats/lifetime', async (req, res) => {
  try {
    // Return cached data if still fresh
    if (_cache.data && Date.now() < _cache.expiresAt) {
      return res.json(_cache.data);
    }

    // No DB connected — return zeros gracefully
    if (!getPool()) {
      return res.json({
        totalPlayers: 0, activeUsers: 0,
        totalHands: 0, totalHandsWon: 0,
        totalRedeemed: 0, biggestPot: 0,
        chipsInPlay: 0,
        asOf: new Date().toISOString(),
      });
    }

    // Aggregate everything in one query for efficiency
    const rows = await query(`
      SELECT
        COUNT(*)::int                          AS total_players,
        COUNT(*) FILTER (
          WHERE last_login >= $1
        )::int                                 AS active_users,
        COALESCE(SUM(hands_played), 0)::bigint AS total_hands,
        COALESCE(SUM(hands_won), 0)::bigint    AS total_hands_won,
        COALESCE(SUM(total_won), 0)::numeric   AS total_won,
        COALESCE(SUM(total_lost), 0)::numeric  AS total_lost,
        COALESCE(SUM(chips), 0)::numeric       AS chips_in_play
      FROM users
      WHERE banned = false
    `, [Date.now() - 7 * 24 * 3600 * 1000]); // 7-day active window

    const r = rows[0] || {};

    const data = {
      totalPlayers:   Number(r.total_players)    || 0,
      activeUsers:    Number(r.active_users)     || 0,
      totalHands:     Number(r.total_hands)      || 0,
      totalHandsWon:  Number(r.total_hands_won)  || 0,
      // For "Royal Chips Redeemed" we use total_won (lifetime winnings paid out)
      totalRedeemed:  Number(r.total_won)        || 0,
      chipsInPlay:    Number(r.chips_in_play)    || 0,
      asOf: new Date().toISOString(),
    };

    _cache = { data, expiresAt: Date.now() + TTL_MS };
    res.json(data);

  } catch (e) {
    console.error('[stats/lifetime]', e.message);
    res.status(500).json({ error: 'stats_failed', message: e.message });
  }
});

module.exports = router;
