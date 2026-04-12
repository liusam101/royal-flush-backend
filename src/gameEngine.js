// ── Deck ──────────────────────────────────────────────────────────────
const RANKS  = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS  = ['♠','♥','♦','♣'];
const RED    = new Set(['♥','♦']);

function rankVal(r) { return RANKS.indexOf(r) + 2; }

function makeDeck() {
  const deck = [];
  for (const s of SUITS)
    for (const r of RANKS)
      deck.push({ r, s, red: RED.has(s) });
  return deck;
}

const { secureRandInt } = require('./rng');
function shuffle(deck) {
  // Fisher-Yates with crypto.randomBytes() — no Math.random()
  for (let i = deck.length - 1; i > 0; i--) {
    const j = secureRandInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ── Hand Scoring ─────────────────────────────────────────────────────
function scoreHand(five) {
  const vals   = five.map(c => rankVal(c.r)).sort((a, b) => b - a);
  const suits  = five.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);

  let isStraight = false, strHigh = vals[0];
  if (vals[0] - vals[4] === 4 && new Set(vals).size === 5) isStraight = true;
  if (vals.join() === [14,5,4,3,2].join()) { isStraight = true; strHigh = 5; }

  const freq   = {};
  vals.forEach(v => freq[v] = (freq[v] || 0) + 1);
  const counts = Object.values(freq).sort((a, b) => b - a);
  const byFreq = Object.entries(freq).sort((a,b) => b[1]-a[1] || b[0]-a[0]).map(e => +e[0]);

  if (isFlush && isStraight && strHigh === 14) return { tier:9, name:'Royal Flush',    tiebreak:[strHigh] };
  if (isFlush && isStraight)                   return { tier:8, name:'Straight Flush',  tiebreak:[strHigh] };
  if (counts[0] === 4)                         return { tier:7, name:'Four of a Kind',  tiebreak:byFreq };
  if (counts[0] === 3 && counts[1] === 2)      return { tier:6, name:'Full House',      tiebreak:byFreq };
  if (isFlush)                                 return { tier:5, name:'Flush',           tiebreak:vals };
  if (isStraight)                              return { tier:4, name:'Straight',        tiebreak:[strHigh] };
  if (counts[0] === 3)                         return { tier:3, name:'Three of a Kind', tiebreak:byFreq };
  if (counts[0] === 2 && counts[1] === 2)      return { tier:2, name:'Two Pair',        tiebreak:byFreq };
  if (counts[0] === 2)                         return { tier:1, name:'Pair',            tiebreak:byFreq };
  return                                              { tier:0, name:'High Card',       tiebreak:vals };
}

function compareScore(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const diff = (a.tiebreak[i] || 0) - (b.tiebreak[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestFive(cards7) {
  let best = null;
  for (let i = 0; i < 7; i++)
    for (let j = i + 1; j < 7; j++) {
      const five  = cards7.filter((_, k) => k !== i && k !== j);
      const score = scoreHand(five);
      if (!best || compareScore(score, best.score) > 0)
        best = { score, five };
    }
  return best;
}

// ── Game Engine class ─────────────────────────────────────────────────
class GameEngine {
  constructor(sb, bb) {
    this.sb   = sb;
    this.bb   = bb;
    this.deck = [];
    this.idx  = 0;
  }

  newDeck() {
    this.deck = shuffle(makeDeck());
    this.idx  = 0;
  }

  _deal() { return this.deck[this.idx++]; }

  dealTwo()  { return [this._deal(), this._deal()]; }
  dealFlop() { return [this._deal(), this._deal(), this._deal()]; }
  dealOne()  { return this._deal(); }

  // How much does the current actor need to call?
  toCall(seats, actIdx) {
    const maxBet = Math.max(...seats.map(s => s.bet || 0));
    return maxBet - (seats[actIdx].bet || 0);
  }

  // Is the current betting round complete?
  // Done when all active players have equal bets (or are all-in)
  bettingRoundDone(seats, actIdx) {
    const active = seats.filter(s => !s.folded && s.stack > 0);
    if (active.length === 0) return true;
    const maxBet = Math.max(...active.map(s => s.bet || 0));
    return active.every(s => (s.bet || 0) === maxBet);
  }

  bestFivePublic(cards7) {
    return bestFive(cards7);
  }

  comparePublic(a, b) {
    return compareScore(a, b);
  }

  showdown(seats, board) {
    const active = seats.filter(s => !s.folded);
    let winner = null, winScore = null;

    for (const seat of active) {
      const seven  = [...seat.cards, ...board];
      const result = bestFive(seven);
      if (!winScore || compareScore(result.score, winScore) > 0) {
        winner   = seat;
        winScore = result.score;
      }
    }

    return { winner: winner?.name, hand: winScore?.name };
  }
}

module.exports = { GameEngine };
