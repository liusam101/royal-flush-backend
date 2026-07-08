-- Seed initial tournament templates. Run once in Railway psql console.
-- Idempotent via ON CONFLICT DO NOTHING.
-- Times are UTC.

INSERT INTO tournament_templates
  (id, name, buy_in, starting_stack, blind_mins, max_players, guarantee, prize_structure, recurrence_type, recurrence_interval, recurrence_time, enabled)
VALUES
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
   true),

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
   true),

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
   true)
ON CONFLICT (id) DO NOTHING;
