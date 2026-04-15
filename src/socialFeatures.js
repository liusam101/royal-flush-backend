// ══════════════════════════════════════════════════════════════════════════
// Social Features — Friends, Sessions, Achievements, Avatars
// ══════════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const SOCIAL_FILE = path.join(DATA_DIR, 'social.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}

function loadSocial() {
  try { return JSON.parse(fs.readFileSync(SOCIAL_FILE, 'utf8')); }
  catch(_) { return { friends: {}, sessions: {}, achievements: {}, avatars: {} }; }
}
function saveSocial(d) { fs.writeFileSync(SOCIAL_FILE, JSON.stringify(d, null, 2)); }

// ── ACHIEVEMENT DEFINITIONS ───────────────────────────────────────────────
const ACHIEVEMENTS = [
  // Hand milestones
  { id: 'first_hand',     icon: '🃏', name: 'First Hand',        desc: 'Play your first hand',            rarity: 'common'   },
  { id: 'hands_10',       icon: '📚', name: 'Student',           desc: 'Play 10 hands',                   rarity: 'common'   },
  { id: 'hands_100',      icon: '🎓', name: 'Graduate',          desc: 'Play 100 hands',                  rarity: 'uncommon' },
  { id: 'hands_1000',     icon: '🏛️', name: 'Veteran',           desc: 'Play 1,000 hands',                rarity: 'rare'     },
  { id: 'hands_10000',    icon: '⚔️', name: 'Grinder',           desc: 'Play 10,000 hands',               rarity: 'epic'     },
  // Hand types
  { id: 'royal_flush',    icon: '👑', name: 'Royal Flush',       desc: 'Hit a Royal Flush',               rarity: 'legendary'},
  { id: 'straight_flush', icon: '🌊', name: 'Straight Flush',    desc: 'Hit a Straight Flush',            rarity: 'epic'     },
  { id: 'quads',          icon: '💎', name: 'Quad Squad',        desc: 'Hit Four of a Kind',              rarity: 'rare'     },
  { id: 'full_house',     icon: '🏠', name: 'Full House',        desc: 'Win with a Full House',           rarity: 'uncommon' },
  // Win milestones
  { id: 'first_win',      icon: '🏆', name: 'First Win',         desc: 'Win your first hand',             rarity: 'common'   },
  { id: 'win_streak_5',   icon: '🔥', name: 'On Fire',           desc: 'Win 5 hands in a row',            rarity: 'uncommon' },
  { id: 'big_pot',        icon: '💰', name: 'Big Pot',           desc: 'Win a pot over $50',              rarity: 'uncommon' },
  { id: 'mega_pot',       icon: '💸', name: 'High Roller',       desc: 'Win a pot over $500',             rarity: 'rare'     },
  { id: 'net_100',        icon: '📈', name: 'In the Black',      desc: 'Reach $100 net profit',           rarity: 'rare'     },
  { id: 'net_1000',       icon: '🚀', name: 'Whale',             desc: 'Reach $1,000 net profit',         rarity: 'epic'     },
  // Social
  { id: 'first_friend',   icon: '🤝', name: 'Making Friends',   desc: 'Add your first friend',           rarity: 'common'   },
  { id: 'friends_5',      icon: '👥', name: 'Social Butterfly',  desc: 'Have 5 friends',                  rarity: 'uncommon' },
  // Bluff / fold
  { id: 'bluff_master',   icon: '🎭', name: 'Bluff Master',      desc: 'Win 10 hands by everyone folding', rarity: 'uncommon'},
  { id: 'comeback',       icon: '📉', name: 'Comeback Kid',      desc: 'Win a hand after being down 80%', rarity: 'rare'    },
  // SNG
  { id: 'sng_win',        icon: '🏅', name: 'SNG Champ',         desc: 'Win a Sit & Go',                  rarity: 'uncommon' },
  { id: 'sng_final',      icon: '🥉', name: 'Final Table',       desc: 'Finish top 3 in a SNG',           rarity: 'common'   },
  // Veteran
  { id: 'one_year',       icon: '🎂', name: 'One Year',          desc: 'Account is 1 year old',           rarity: 'epic'     },
];

const ACHIEVEMENT_MAP = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));

// ── ACHIEVEMENT LOGIC ─────────────────────────────────────────────────────
function checkAchievements(userId, context) {
  // context: { handsPlayed, handsWon, totalWon, totalLost, lastHand, winStreak, biggestPot }
  const social  = loadSocial();
  if (!social.achievements[userId]) social.achievements[userId] = {};
  const earned  = social.achievements[userId];
  const newOnes = [];

  function unlock(id) {
    if (earned[id]) return;
    earned[id] = { unlockedAt: Date.now() };
    newOnes.push({ ...ACHIEVEMENT_MAP[id], unlockedAt: earned[id].unlockedAt });
  }

  const { handsPlayed=0, handsWon=0, totalWon=0, totalLost=0,
          lastHand='', winStreak=0, biggestPot=0, friendCount=0,
          bluffWins=0, sngWins=0, sngFinals=0, createdAt=Date.now() } = context;

  // Hand counts
  if (handsPlayed >= 1)     unlock('first_hand');
  if (handsPlayed >= 10)    unlock('hands_10');
  if (handsPlayed >= 100)   unlock('hands_100');
  if (handsPlayed >= 1000)  unlock('hands_1000');
  if (handsPlayed >= 10000) unlock('hands_10000');
  // Hand types
  if (lastHand === 'Royal Flush')    unlock('royal_flush');
  if (lastHand === 'Straight Flush') unlock('straight_flush');
  if (lastHand === 'Four of a Kind') unlock('quads');
  if (lastHand === 'Full House')     unlock('full_house');
  // Wins
  if (handsWon >= 1)    unlock('first_win');
  if (winStreak >= 5)   unlock('win_streak_5');
  if (biggestPot >= 50) unlock('big_pot');
  if (biggestPot >= 500) unlock('mega_pot');
  const net = totalWon - totalLost;
  if (net >= 100)  unlock('net_100');
  if (net >= 1000) unlock('net_1000');
  // Social
  if (friendCount >= 1) unlock('first_friend');
  if (friendCount >= 5) unlock('friends_5');
  // Bluff
  if (bluffWins >= 10) unlock('bluff_master');
  // SNG
  if (sngWins >= 1)   unlock('sng_win');
  if (sngFinals >= 1) unlock('sng_final');
  // Age
  if (Date.now() - createdAt >= 365*24*3600*1000) unlock('one_year');

  if (newOnes.length) saveSocial(social);
  return newOnes;
}

function getUserAchievements(userId) {
  const social = loadSocial();
  const earned = social.achievements[userId] || {};
  return ACHIEVEMENTS.map(a => ({
    ...a,
    earned: !!earned[a.id],
    unlockedAt: earned[a.id]?.unlockedAt || null,
  }));
}

// ── SESSIONS ─────────────────────────────────────────────────────────────
function startUserSession(userId, sessionData) {
  // sessionData: { table, stake, buyIn }
  const social = loadSocial();
  if (!social.sessions[userId]) social.sessions[userId] = [];
  const session = {
    id: 's' + Date.now(),
    table: sessionData.table || 'Unknown',
    stake: sessionData.stake || '',
    buyIn: sessionData.buyIn || 0,
    startTime: Date.now(),
    endTime: null,
    handsPlayed: 0,
    netResult: 0,
    status: 'active',
  };
  social.sessions[userId].unshift(session);
  if (social.sessions[userId].length > 100) social.sessions[userId].pop();
  saveSocial(social);
  return session.id;
}

function endUserSession(userId, sessionId, result) {
  // result: { handsPlayed, netResult, cashOut }
  const social = loadSocial();
  if (!social.sessions[userId]) return;
  const session = social.sessions[userId].find(s => s.id === sessionId);
  if (!session) return;
  session.endTime    = Date.now();
  session.durationMs = session.endTime - session.startTime;
  session.handsPlayed = result.handsPlayed || 0;
  session.netResult   = result.netResult   || 0;
  session.cashOut     = result.cashOut     || 0;
  session.status      = 'completed';
  saveSocial(social);
}

function getUserSessions(userId, limit=20) {
  const social = loadSocial();
  return (social.sessions[userId] || []).slice(0, limit);
}

// ── FRIENDS ───────────────────────────────────────────────────────────────
function addFriend(userId, friendId) {
  if (userId === friendId) return { ok: false, error: "Can't add yourself" };
  const social = loadSocial();
  if (!social.friends[userId]) social.friends[userId] = [];
  if (!social.friends[friendId]) social.friends[friendId] = [];
  if (social.friends[userId].includes(friendId))
    return { ok: false, error: 'Already friends' };
  social.friends[userId].push(friendId);
  social.friends[friendId].push(userId); // mutual
  saveSocial(social);
  return { ok: true };
}

function removeFriend(userId, friendId) {
  const social = loadSocial();
  if (social.friends[userId])
    social.friends[userId] = social.friends[userId].filter(id => id !== friendId);
  if (social.friends[friendId])
    social.friends[friendId] = social.friends[friendId].filter(id => id !== userId);
  saveSocial(social);
  return { ok: true };
}

function getFriends(userId) {
  const social = loadSocial();
  return social.friends[userId] || [];
}

// ── AVATARS ───────────────────────────────────────────────────────────────
// Store avatars as base64 data URLs (max ~50KB for profile pics)
const MAX_AVATAR_SIZE = 60000; // ~60KB base64

function saveAvatar(userId, base64DataUrl) {
  if (!base64DataUrl || !base64DataUrl.startsWith('data:image/')) {
    return { ok: false, error: 'Invalid image format' };
  }
  if (base64DataUrl.length > MAX_AVATAR_SIZE) {
    return { ok: false, error: 'Image too large (max ~40KB)' };
  }
  const social = loadSocial();
  social.avatars[userId] = { data: base64DataUrl, updatedAt: Date.now() };
  saveSocial(social);
  return { ok: true };
}

function getAvatar(userId) {
  const social = loadSocial();
  return social.avatars[userId]?.data || null;
}

function getAvatars(userIds) {
  const social = loadSocial();
  const result = {};
  userIds.forEach(id => { if (social.avatars[id]) result[id] = social.avatars[id].data; });
  return result;
}

module.exports = {
  ACHIEVEMENTS, checkAchievements, getUserAchievements,
  startUserSession, endUserSession, getUserSessions,
  addFriend, removeFriend, getFriends,
  saveAvatar, getAvatar, getAvatars,
};
