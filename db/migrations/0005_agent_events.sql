-- Agent event system (docs/agent-events.md): durable inbox, timers, resource
-- locks, and the run columns for attempts / structured results / parking /
-- questions / generation rollover.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "result" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "park_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "pending_question" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "superseded_by" integer;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "target_run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "audience" text NOT NULL DEFAULT 'owner',
  "source_kind" text NOT NULL,
  "source_id" text,
  "correlation_id" text,
  "causation_event_id" integer,
  "attempt" integer,
  "bubbled_from" integer,
  "dedupe_key" text,
  "status" text NOT NULL DEFAULT 'pending',
  "run_turn_id" integer,
  "error_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "injected_at" timestamptz
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_target_pending_idx" ON "inbox_events" ("target_run_id","audience","id") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inbox_dedupe_idx" ON "inbox_events" ("target_run_id","dedupe_key") WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_correlation_idx" ON "inbox_events" ("correlation_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_timers" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "fire_at" timestamptz NOT NULL,
  "note" text,
  "correlation_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "fired_at" timestamptz
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_timers_due_idx" ON "run_timers" ("fire_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_timers_run_idx" ON "run_timers" ("run_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_locks" (
  "resource" text PRIMARY KEY NOT NULL,
  "owner_run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "acquired_at" timestamptz NOT NULL DEFAULT now()
);
