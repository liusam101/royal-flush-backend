// ══════════════════════════════════════════════════════════════════════════
// Advanced Bot Detection — Beyond Timing Analysis
// Bots that add random jitter still leave statistical fingerprints.
// Real detection uses behavioral patterns that are hard to fake.
// ══════════════════════════════════════════════════════════════════════════

// ── WHY TIMING ALONE FAILS AGAINST SOPHISTICATED BOTS ─────────────────────
// A bot with jitter like Math.random()*3000+500 will have:
//   - Mean: ~2000ms (looks human)
//   - σ:    ~866ms  (looks human)
// Our basic check would miss it entirely.
// 
// But bots still have tells in WHAT they do, not just WHEN.

// ══════════════════════════════════════════════════════════════════════════
// LAYER 1: DECISION CONSISTENCY ANALYSIS
// Humans make mistakes. Bots playing GTO rarely do.
// ══════════════════════════════════════════════════════════════════════════

// Track decisions in identical or near-identical situations
// A bot will make the SAME decision in the same spot every time.
// A human will occasionally mix up or make mistakes.
//
// Example: 3-bet pot, in position, continuation bet on dry board →
//   Human: folds sometimes even when ahead (tilt, variance, mistake)
//   Bot: always makes the EV+ play

class DecisionConsistencyTracker {
  constructor() {
    // Map situation fingerprint → [decisions made]
    this.situationMap = new Map();
  }

  // Create a rough fingerprint of the current game situation
  fingerprintSituation(ctx) {
    // Bucket continuous values to create matchable situations
    const potBucket     = Math.round(ctx.potOdds * 10) / 10;  // round to nearest 10%
    const stackBucket   = ctx.stackDepth < 20 ? 'short' : ctx.stackDepth < 40 ? 'mid' : 'deep';
    const phaseBucket   = ctx.phase;
    const positionBucket= ctx.position; // 'ip' | 'oop'
    const actionBucket  = ctx.facingAction; // 'bet'|'raise'|'check'|'none'
    return `${phaseBucket}:${positionBucket}:${actionBucket}:${potBucket}:${stackBucket}`;
  }

  record(playerId, situation, decision) {
    const key = `${playerId}:${situation}`;
    if (!this.situationMap.has(key)) this.situationMap.set(key, []);
    this.situationMap.get(key).push(decision);
  }

  // Returns 0-1 consistency score. Humans ~0.6-0.8. Bots ~0.95-1.0
  getConsistencyScore(playerId) {
    let totalSituations = 0, consistentSituations = 0;
    for (const [key, decisions] of this.situationMap) {
      if (!key.startsWith(playerId + ':')) continue;
      if (decisions.length < 3) continue; // need enough sample per situation
      totalSituations++;
      const topDecision = decisions.reduce((acc, d) => {
        acc[d] = (acc[d]||0)+1; return acc;
      }, {});
      const maxFreq = Math.max(...Object.values(topDecision));
      if (maxFreq / decisions.length >= 0.90) consistentSituations++;
    }
    if (totalSituations < 2) return null; // lower threshold for testing
    return consistentSituations / totalSituations;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LAYER 2: MOUSE/INTERACTION ENTROPY (client-side)
// Bots clicking buttons leave no mouse movement trail.
// Real players move their cursor, hover, sometimes mis-click.
// ══════════════════════════════════════════════════════════════════════════
//
// The client sends an "interaction signature" with each action:
// {
//   mouseMovements: 47,   // # of mousemove events since last action
//   mouseDistance:  380,  // total pixels traveled
//   hoverTime:      240,  // ms spent hovering over the button before click
//   clickX:         0.48, // x position as % of button width (bots always ~0.5)
//   clickY:         0.51, // y position as % of button height
//   keystrokes:     0,    // any keyboard activity
//   scrollEvents:   2,    // scroll events (bots don't scroll)
//   focusLost:      false,// tab was active during decision
// }
//
// A bot clicking via script will have:
//   mouseMovements: 0
//   hoverTime: 0-5ms
//   clickX: exactly 0.5 (center of element)

function analyzeInteractionSignature(sig) {
  if (!sig) return { botScore: 0.5, reasons: ['no_signature'] };

  const reasons = [];
  let botScore  = 0;

  // Zero mouse movement → likely programmatic click
  if (sig.mouseMovements === 0) {
    botScore += 0.35;
    reasons.push('no_mouse_movement');
  } else if (sig.mouseMovements < 3) {
    botScore += 0.15;
    reasons.push('minimal_mouse_movement');
  }

  // Instant hover → no human hesitation
  if (sig.hoverTime < 30) {
    botScore += 0.25;
    reasons.push('instant_hover');
  }

  // Perfect center click → programmatic
  const cx = Math.abs(sig.clickX - 0.5);
  const cy = Math.abs(sig.clickY - 0.5);
  if (cx < 0.02 && cy < 0.02) {
    botScore += 0.20;
    reasons.push('perfect_center_click');
  }

  // Tab was inactive but action was taken → headless browser
  if (sig.focusLost) {
    botScore += 0.30;
    reasons.push('tab_inactive_during_action');
  }

  // No scroll events ever = bot (real players always scroll lobby, history, etc.)
  if (sig.totalScrollEvents === 0 && sig.sessionAge > 60000) {
    botScore += 0.10;
    reasons.push('no_scroll_activity');
  }

  return { botScore: Math.min(botScore, 1), reasons };
}

// ══════════════════════════════════════════════════════════════════════════
// LAYER 3: SESSION PATTERN ANALYSIS
// Bots play 24/7. Humans sleep, have variance in session length.
// ══════════════════════════════════════════════════════════════════════════

function analyzeSessionPatterns(sessions) {
  // sessions: array of { start, end, handsPlayed } over multiple days
  if (sessions.length < 5) return null;

  const durations  = sessions.map(s => s.end - s.start);
  const gaps       = [];
  for (let i = 1; i < sessions.length; i++) {
    gaps.push(sessions[i].start - sessions[i-1].end);
  }

  const avgGap    = gaps.reduce((a,b)=>a+b,0) / gaps.length;
  const avgDur    = durations.reduce((a,b)=>a+b,0) / durations.length;
  const hourDist  = new Array(24).fill(0);
  sessions.forEach(s => { hourDist[new Date(s.start).getHours()]++; });

  // Bots: play at all hours evenly. Humans: cluster around day/evening
  const hourEntropy = _entropy(hourDist);
  const maxHourEntropy = Math.log2(24); // 4.58 bits — perfectly uniform
  const normalizedEntropy = hourEntropy / maxHourEntropy;

  // Bots: gaps between sessions are very short (restart quickly)
  // Bots: session durations are very consistent
  const gapSigma = _sigma(gaps);
  const durSigma = _sigma(durations);

  const flags = [];
  if (normalizedEntropy > 0.92) flags.push('plays_all_hours'); // too uniform
  if (gapSigma < 60000 && gaps.length > 5) flags.push('consistent_restart_gaps'); // robotic
  if (durSigma < 120000 && durations.length > 5) flags.push('consistent_session_length');
  if (avgGap < 30000 && gaps.length > 3) flags.push('instant_reconnect');

  return { hourEntropy: normalizedEntropy, flags, avgGapMs: avgGap, avgDurMs: avgDur };
}

// ══════════════════════════════════════════════════════════════════════════
// LAYER 4: HAND STRENGTH CORRELATION
// Bots fold/call/raise in perfect correlation with hand strength.
// Humans bluff, hero-call, tilt, and make mistakes.
// ══════════════════════════════════════════════════════════════════════════
//
// After showdown, we know hole cards + actions.
// Track: when player had top-pair or better, did they bet/raise?
//        when they had air, did they fold or bluff (and at what frequency)?
//
// Bot tells:
//   - Continuation bet frequency exactly 65-70% (solver optimal)
//   - Bluff frequency exactly 33% on missed draws (solver optimal)  
//   - Never donk-bet (solvers rarely do)
//   - Always check-raise at exact frequencies

class HandStrengthCorrelator {
  constructor() {
    this.records = []; // { handStrengthTier, action, phase, position }
  }

  record(handStrengthTier, action, phase, position) {
    // handStrengthTier: 0=air, 1=weak, 2=medium, 3=strong, 4=monster
    this.records.push({ tier: handStrengthTier, action, phase, position });
    if (this.records.length > 500) this.records.shift();
  }

  analyze() {
    if (this.records.length < 50) return null;

    // For each strength tier, what % do they fold/call/raise?
    const byTier = {};
    for (const r of this.records) {
      if (!byTier[r.tier]) byTier[r.tier] = {fold:0,call:0,raise:0,total:0};
      byTier[r.tier][r.action]++;
      byTier[r.tier].total++;
    }

    const anomalies = [];

    // Check for solver-perfect frequencies
    for (const [tier, counts] of Object.entries(byTier)) {
      if (counts.total < 10) continue;
      const foldPct  = counts.fold  / counts.total;
      const raisePct = counts.raise / counts.total;

      // With air (tier 0): GTO folds ~70%, bluffs ~30%
      // A bot will be EXACTLY at these frequencies, humans vary ±15%
      if (tier == 0 && Math.abs(foldPct - 0.70) < 0.04 && counts.total > 20) {
        anomalies.push(`air_fold_rate_exact:${(foldPct*100).toFixed(1)}%`);
      }
      // With strong (tier 3+): GTO bets ~75%
      if (tier >= 3 && Math.abs(raisePct - 0.75) < 0.04 && counts.total > 15) {
        anomalies.push(`strong_bet_rate_exact:${(raisePct*100).toFixed(1)}%`);
      }
    }

    return { byTier, anomalies };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LAYER 5: CROSS-ACCOUNT CORRELATION
// Bot farms run multiple accounts that behave identically.
// Compare action sequences across accounts — if two accounts
// make the same decisions in the same spots, they share a bot core.
// ══════════════════════════════════════════════════════════════════════════

function correlateAccounts(playerA_actions, playerB_actions) {
  // Action sequences: [{situation, decision}]
  // Find overlapping situations and compare decisions
  const aMap = new Map(playerA_actions.map(x => [x.situation, x.decision]));
  const bMap = new Map(playerB_actions.map(x => [x.situation, x.decision]));

  let shared = 0, matching = 0;
  for (const [sit, decA] of aMap) {
    if (bMap.has(sit)) {
      shared++;
      if (bMap.get(sit) === decA) matching++;
    }
  }

  if (shared < 5) return null;
  const correlation = matching / shared;
  // Two random humans share ~55-65% of decisions in same spots
  // Same bot core: >85% correlation
  return {
    correlation,
    shared,
    matching,
    suspicious: correlation > 0.85,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════════════════════
function _sigma(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
  return Math.sqrt(arr.reduce((a,b)=>a+(b-mean)**2,0)/arr.length);
}

function _entropy(dist) {
  const total = dist.reduce((a,b)=>a+b,0);
  if (!total) return 0;
  return -dist.filter(v=>v>0).reduce((s,v)=>{
    const p=v/total; return s+p*Math.log2(p);
  },0);
}

// ══════════════════════════════════════════════════════════════════════════
// INTEGRATION — wire into antiCheat
// ══════════════════════════════════════════════════════════════════════════

// These are the signals to collect client-side and send on each action:
const CLIENT_SIGNALS_SCHEMA = {
  mouseMovements:    'number',  // mousemove events since last action
  mouseDistance:     'number',  // pixels traveled (approx)
  hoverTime:         'number',  // ms hovering over the action button
  clickX:            'number',  // 0-1 position within button
  clickY:            'number',  // 0-1 position within button
  focusLost:         'boolean', // window.hidden during decision
  totalScrollEvents: 'number',  // cumulative session scroll count
  sessionAge:        'number',  // ms since page load
  keystrokes:        'number',  // any keypress events
};

module.exports = {
  DecisionConsistencyTracker,
  HandStrengthCorrelator,
  analyzeInteractionSignature,
  analyzeSessionPatterns,
  correlateAccounts,
  CLIENT_SIGNALS_SCHEMA,
};
