// ══════════════════════════════════════════════════════════════════════════
// Tournament scheduler — generates concrete tournament instances from templates.
// Runs on boot + hourly. Idempotent via UNIQUE(template_id, start_time).
// ══════════════════════════════════════════════════════════════════════════
const { getPool, query: dbQuery, withTransaction } = require('./db');

const GENERATE_HORIZON_MS = 8 * 24 * 60 * 60 * 1000; // 8 days ahead (covers weekly tournaments)

// ── Recurrence expansion ───────────────────────────────────────────────────
// Given a template + a window [now, now+horizon], return the start times (Date[])
// where instances should exist.
function expandRecurrence(tpl, from, to) {
  const type = tpl.recurrence_type || 'once';
  const time = tpl.recurrence_time || null;
  const interval = tpl.recurrence_interval || 1;

  if (type === 'once') {
    // recurrence_time is an ISO timestamp
    if (!time) return [];
    const dt = new Date(time);
    if (isNaN(dt.getTime())) return [];
    if (dt < from || dt > to) return [];
    return [dt];
  }

  if (type === 'hourly') {
    // Every `interval` hours anchored at midnight UTC + offset from recurrence_time (HH:MM UTC).
    // Default anchor 00:00 if no time given.
    if (interval <= 0) return []; // guard against infinite loop from bad template data
    const [hh, mm] = (time || '00:00').split(':').map(Number);
    const offsetMs = ((hh || 0) * 60 + (mm || 0)) * 60000;
    const intervalMs = interval * 60 * 60 * 1000;
    // Find first slot >= from
    const anchor0 = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()) + offsetMs;
    let slot = anchor0;
    while (slot < from.getTime()) slot += intervalMs;
    const out = [];
    while (slot <= to.getTime()) {
      out.push(new Date(slot));
      slot += intervalMs;
    }
    return out;
  }

  if (type === 'daily') {
    // recurrence_time = "HH:MM" UTC
    const [hh, mm] = (time || '00:00').split(':').map(Number);
    const out = [];
    let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hh || 0, mm || 0));
    while (d < from) d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    while (d <= to) {
      out.push(new Date(d));
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    }
    return out;
  }

  if (type === 'weekly') {
    // recurrence_time = "DOW-HH:MM" where DOW = 0..6 (0=Sunday) UTC
    const m = (time || '').match(/^(\d)-(\d{1,2}):(\d{2})$/);
    if (!m) return [];
    const dow = parseInt(m[1], 10);
    const hh = parseInt(m[2], 10);
    const mm = parseInt(m[3], 10);
    if (dow < 0 || dow > 6) return []; // guard against infinite loop from bad DOW
    const out = [];
    // Anchor: today at hh:mm UTC, then shift to matching DOW
    let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hh, mm));
    while (d.getUTCDay() !== dow) d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    while (d < from) d = new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000);
    while (d <= to) {
      out.push(new Date(d));
      d = new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
    return out;
  }

  return [];
}

// ── Instance ID: deterministic per (template, start_time) so re-runs are idempotent
function makeInstanceId(templateId, startTime) {
  const epoch = Math.floor(startTime.getTime() / 1000);
  return `${templateId}_${epoch}`;
}

// ── Main generator ─────────────────────────────────────────────────────────
async function generateUpcomingTournaments() {
  if (!getPool()) return { generated: 0, skipped: 0 };
  const templates = await dbQuery(`SELECT * FROM tournament_templates WHERE enabled = true`);
  if (!templates.length) return { generated: 0, skipped: 0 };

  const from = new Date();
  const to   = new Date(from.getTime() + GENERATE_HORIZON_MS);
  let generated = 0, skipped = 0;

  for (const tpl of templates) {
    const times = expandRecurrence(tpl, from, to);
    for (const startTime of times) {
      const id = makeInstanceId(tpl.id, startTime);
      try {
        const result = await withTransaction(async (client) => {
          const r = await client.query(
            `INSERT INTO tournaments
               (id, template_id, name, buy_in, starting_stack, blind_mins, max_players, guarantee,
                prize_structure, start_time, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled')
             ON CONFLICT (template_id, start_time) WHERE template_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [id, tpl.id, tpl.name, tpl.buy_in, tpl.starting_stack, tpl.blind_mins,
             tpl.max_players, tpl.guarantee, JSON.stringify(tpl.prize_structure), startTime]);
          return r.rowCount;
        });
        if (result > 0) generated++; else skipped++;
      } catch (e) {
        console.error(`[TournScheduler] Failed to insert instance for ${tpl.id} @ ${startTime.toISOString()}:`, e.message);
      }
    }
  }
  if (generated > 0) console.log(`[TournScheduler] Generated ${generated} tournament instances (${skipped} already existed).`);
  return { generated, skipped };
}

module.exports = { generateUpcomingTournaments, expandRecurrence };
