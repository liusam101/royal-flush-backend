// src/achievements.js — declarative achievement definitions + unlock helper.
// Called from server hand-result / tournament-finish paths. All DB writes are
// safe idempotent via PRIMARY KEY (user_id, achievement_id).
const { query: dbQuery, getPool } = require('./db');

// Achievement definitions. Each has:
//   id: TEXT PRIMARY KEY value
//   name: shown to player
//   description: shown to player
//   icon: emoji shown on the badge
//   checkFn(userStats) => boolean — return true if the user has now earned it
// userStats is the user row (from DB) — SELECT * FROM users WHERE id=$1
const ACHIEVEMENTS = [
  {
    id: 'first_hand',
    name: 'First Hand',
    description: 'Play your very first hand of poker',
    icon: '🃏',
    check: u => (u.hands_played || 0) >= 1,
  },
  {
    id: 'first_mtt_entry',
    name: 'Tournament Debut',
    description: 'Register for your first tournament',
    icon: '🎟️',
    check: u => (u.mtt_played || 0) >= 1,
  },
  {
    id: 'first_itm',
    name: 'In the Money',
    description: 'Finish a tournament in a paying position',
    icon: '💰',
    check: u => (u.mtt_itm_count || 0) >= 1,
  },
  {
    id: 'first_mtt_win',
    name: 'Champion',
    description: 'Win your first tournament',
    icon: '🏆',
    check: u => (u.mtt_wins || 0) >= 1,
  },
  {
    id: 'triple_crown',
    name: 'Triple Crown',
    description: 'Win 3 tournaments',
    icon: '👑',
    check: u => (u.mtt_wins || 0) >= 3,
  },
  {
    id: 'shark',
    name: 'Shark',
    description: 'Win 10 tournaments',
    icon: '🦈',
    check: u => (u.mtt_wins || 0) >= 10,
  },
  {
    id: 'grinder',
    name: 'Grinder',
    description: 'Play 100 hands of poker',
    icon: '💪',
    check: u => (u.hands_played || 0) >= 100,
  },
  {
    id: 'workhorse',
    name: 'Workhorse',
    description: 'Play 1,000 hands of poker',
    icon: '🐴',
    check: u => (u.hands_played || 0) >= 1000,
  },
  {
    id: 'high_roller_100',
    name: 'High Roller',
    description: 'Cash for $100+ in a single tournament',
    icon: '💎',
    check: u => Number(u.mtt_biggest_cash || 0) >= 100,
  },
  {
    id: 'regular',
    name: 'Regular',
    description: 'Register for 25 tournaments',
    icon: '📅',
    check: u => (u.mtt_played || 0) >= 25,
  },
  {
    id: 'consistent',
    name: 'Consistent',
    description: 'Cash 10 tournaments (ITM)',
    icon: '🎯',
    check: u => (u.mtt_itm_count || 0) >= 10,
  },
  {
    id: 'showdown_master',
    name: 'Showdown Master',
    description: 'Win 50 hands at showdown',
    icon: '👀',
    check: u => (u.showdown_wins || 0) >= 50,
  },
];

// Given a userId, load their row and check every achievement. Insert any newly-earned
// ones into user_achievements. Returns [{id,name,icon,description}] for newly unlocked.
async function checkAchievementsForUser(userId) {
  if (!getPool() || !userId) return [];
  try {
    const rows = await dbQuery(`SELECT * FROM users WHERE id=$1`, [userId]);
    if (!rows.length) return [];
    const u = rows[0];
    const alreadyUnlocked = await dbQuery(
      `SELECT achievement_id FROM user_achievements WHERE user_id=$1`, [userId]);
    const have = new Set(alreadyUnlocked.map(r => r.achievement_id));
    const earned = [];
    for (const def of ACHIEVEMENTS) {
      if (have.has(def.id)) continue;
      let ok = false;
      try { ok = !!def.check(u); } catch(_) { ok = false; }
      if (!ok) continue;
      try {
        await dbQuery(
          `INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2)
           ON CONFLICT (user_id, achievement_id) DO NOTHING`,
          [userId, def.id]);
        earned.push({ id: def.id, name: def.name, description: def.description, icon: def.icon });
      } catch(e) { console.error('[Achievements] insert failed for', userId, def.id, e.message); }
    }
    return earned;
  } catch(e) {
    console.error('[Achievements] check failed:', e.message);
    return [];
  }
}

// Fetch all achievement definitions with per-user unlock state.
async function getUserAchievements(userId) {
  const list = ACHIEVEMENTS.map(a => ({
    id: a.id, name: a.name, description: a.description, icon: a.icon,
    unlocked: false, unlockedAt: null,
  }));
  if (!getPool() || !userId) return list;
  try {
    const rows = await dbQuery(
      `SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id=$1`, [userId]);
    const map = new Map(rows.map(r => [r.achievement_id, r.unlocked_at]));
    for (const a of list) {
      if (map.has(a.id)) {
        a.unlocked = true;
        a.unlockedAt = map.get(a.id);
      }
    }
  } catch(_) {}
  return list;
}

module.exports = { checkAchievementsForUser, getUserAchievements, ACHIEVEMENTS };
