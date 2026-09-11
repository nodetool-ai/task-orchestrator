ALTER TABLE "run_timers"
  ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'watchdog' NOT NULL;
--> statement-breakpoint
ALTER TABLE "run_timers"
  DROP CONSTRAINT IF EXISTS "run_timers_kind_check";
--> statement-breakpoint
ALTER TABLE "run_timers"
  ADD CONSTRAINT "run_timers_kind_check"
  CHECK ("kind" IN ('sleep', 'watchdog', 'deadline'));
--> statement-breakpoint
-- Preserve the currently active sleep across deployment. Historical rows are
-- intentionally left as watchdogs because the old schema could not distinguish
-- timer__sleep from timer__set; for each sleeping run, only its newest pending
-- timer can be the active maximum-wait sleep.
WITH active_sleep AS (
  SELECT DISTINCT ON (t.run_id) t.id
    FROM run_timers t
    JOIN agent_runs r ON r.id = t.run_id
   WHERE t.status = 'pending'
     AND r.park_reason = 'sleeping'
   ORDER BY t.run_id, t.created_at DESC, t.id DESC
)
UPDATE run_timers t
   SET kind = 'sleep'
  FROM active_sleep s
 WHERE t.id = s.id;
