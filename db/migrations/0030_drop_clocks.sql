-- Liveness without clocks (docs/plans/liveness-without-clocks.md, step 3).
-- Liveness is the provider verdict; these columns were time-based proxies.
DROP INDEX IF EXISTS "agent_runs_live_worker_heartbeat_idx";
DROP INDEX IF EXISTS "runner_instances_controller_lease_expires_at_idx";
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "heartbeat_at";
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "worker_pid";
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "pending_since" timestamp with time zone;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "wake_requested_at";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "controller_lease_expires_at";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "channel_connected_at";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "channel_last_seen_at";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "last_suspended_at";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "fly_app";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "machine_id";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "volume_id";
