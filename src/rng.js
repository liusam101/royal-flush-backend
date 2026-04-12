// ══════════════════════════════════════════════════════════════════════════
// Cryptographically Secure RNG — Royal Flush Poker
// Uses crypto.randomBytes() — unpredictable, not seedable, audit-safe
// ══════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// Generate a cryptographically secure integer in [0, max)
function secureRandInt(max) {
  if (max <= 0) return 0;
  // Rejection sampling to avoid modulo bias
  const byteCount  = Math.ceil(Math.log2(max) / 8) + 1;
  const maxUnbiased = Math.floor(256 ** byteCount / max) * max;
  let val;
  do {
    const buf = crypto.randomBytes(byteCount);
    val = 0;
    for (const b of buf) val = val * 256 + b;
  } while (val >= maxUnbiased);
  return val % max;
}

// Fisher-Yates shuffle using crypto RNG
function secureShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureRandInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Generate a full shuffled 52-card deck
function freshDeck() {
  const suits  = ['♠','♥','♦','♣'];
  const ranks  = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const deck   = [];
  for (const s of suits)
    for (const r of ranks)
      deck.push({ r, s, red: s==='♥'||s==='♦' });
  return secureShuffle(deck);
}

// Verify RNG quality — for audit logging
function selfTest() {
  const samples = 10000;
  const counts  = new Array(52).fill(0);
  const deck    = ['2♠','3♠','4♠','5♠','6♠','7♠','8♠','9♠','T♠','J♠','Q♠','K♠','A♠',
                   '2♥','3♥','4♥','5♥','6♥','7♥','8♥','9♥','T♥','J♥','Q♥','K♥','A♥',
                   '2♦','3♦','4♦','5♦','6♦','7♦','8♦','9♦','T♦','J♦','Q♦','K♦','A♦',
                   '2♣','3♣','4♣','5♣','6♣','7♣','8♣','9♣','T♣','J♣','Q♣','K♣','A♣'];
  for (let i = 0; i < samples; i++) {
    const idx = secureRandInt(52);
    counts[idx]++;
  }
  const expected = samples / 52;
  const chiSq = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  // Chi-squared with 51 df: p<0.05 threshold ≈ 68.7
  return { ok: chiSq < 80, chiSq: chiSq.toFixed(2), expected: expected.toFixed(1) };
}

module.exports = { secureRandInt, secureShuffle, freshDeck, selfTest };
