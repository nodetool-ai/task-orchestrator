-- db/migrations/0019_pending_reason.sql
-- Why a 'pending' run is pending (admission defer reason: template build,
-- capacity, account backpressure). Mirrors park_reason for parked runs.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "pending_reason" text;
