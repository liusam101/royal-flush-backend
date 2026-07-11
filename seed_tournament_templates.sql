-- Seed initial tournament templates. Run once in Railway psql console.
-- Idempotent via ON CONFLICT DO NOTHING.
-- Times are UTC.

INSERT INTO tournament_templates
  (id, name, buy_in, starting_stack, blind_mins, max_players, guarantee, prize_structure, recurrence_type, recurrence_interval, recurrence_time, enabled, currency)
VALUES
  -- ── ROYAL (Barrel Chip) ────────────────────────────────────────────────
  -- Hourly Micro: every 2 hours starting at :00 UTC. $0.10 buy-in, 6-max.
  ('hourly_micro',
   'Hourly Micro',
   0.10,
   1500,
   5,
   6,
   0,
   '[65, 35]'::jsonb,
   'hourly',
   2,
   '00:00',
   true,
   'royal'),

  -- Daily Turbo: every day at 20:00 UTC. $1 buy-in, 9-max.
  ('daily_turbo',
   'Daily Turbo',
   1.00,
   3000,
   8,
   9,
   0,
   '[50, 30, 20]'::jsonb,
   'daily',
   NULL,
   '20:00',
   true,
   'royal'),

  -- Weekly Sunday Major: Sundays at 18:00 UTC. $5 buy-in, up to 27 players, $50 guarantee.
  ('weekly_sunday_major',
   'Sunday Major',
   5.00,
   5000,
   12,
   27,
   50.00,
   '[25, 15, 10, 8, 6, 5, 4, 3, 2]'::jsonb,
   'weekly',
   NULL,
   '0-18:00',
   true,
   'royal'),

  -- ── GOLD (Gold Chip / free play) ───────────────────────────────────────
  -- Blinds/prize structure mirrors the Royal ones with x200 scaling to line
  -- up with the 250k GC starting balance new users get.
  ('hourly_micro_g',
   'Hourly Micro',
   20,
   1500,
   5,
   6,
   0,
   '[65, 35]'::jsonb,
   'hourly',
   2,
   '00:00',
   true,
   'gold'),

  ('daily_turbo_g',
   'Daily Turbo',
   200,
   3000,
   8,
   9,
   0,
   '[50, 30, 20]'::jsonb,
   'daily',
   NULL,
   '20:00',
   true,
   'gold'),

  ('weekly_sunday_major_g',
   'Sunday Major',
   1000,
   5000,
   12,
   27,
   10000,
   '[25, 15, 10, 8, 6, 5, 4, 3, 2]'::jsonb,
   'weekly',
   NULL,
   '0-18:00',
   true,
   'gold')
ON CONFLICT (id) DO NOTHING;
