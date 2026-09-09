CREATE TABLE IF NOT EXISTS "run_source_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE RESTRICT,
  "revision" bigint NOT NULL,
  "attempt" integer NOT NULL,
  "logical_turn_id" uuid,
  "worker_generation" integer,
  "event_type" text NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "producer_key" text NOT NULL,
  CONSTRAINT "run_source_events_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "delivery_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "delivery_version" SET DEFAULT 2;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_source_events_source_revision_uniq" ON "run_source_events" ("source_run_id", "revision");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_source_events_source_producer_uniq" ON "run_source_events" ("source_run_id", "producer_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_source_events_source_revision_idx" ON "run_source_events" ("source_run_id", "revision");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_event_subscriptions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "subscriber_run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "source_run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE RESTRICT,
  "event_types" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "attempt_mode" text NOT NULL DEFAULT 'current',
  "resolved_attempt" integer,
  "replay_mode" text NOT NULL DEFAULT 'future_only',
  "lifetime" text NOT NULL DEFAULT 'until_unsubscribed',
  "keep_open" boolean NOT NULL DEFAULT false,
  "start_revision" bigint NOT NULL,
  "end_revision" bigint,
  "status" text NOT NULL DEFAULT 'active',
  "client_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "cancelled_at" timestamptz,
  CONSTRAINT "run_event_subscriptions_start_revision_check" CHECK ("start_revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_event_subscriptions_subscriber_client_uniq" ON "run_event_subscriptions" ("subscriber_run_id", "client_key") WHERE "client_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_event_subscriptions_source_active_idx" ON "run_event_subscriptions" ("source_run_id", "status", "start_revision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_event_subscriptions_subscriber_active_idx" ON "run_event_subscriptions" ("subscriber_run_id", "status");
--> statement-breakpoint
ALTER TABLE "inbox_events" ADD COLUMN IF NOT EXISTS "source_event_id" uuid REFERENCES "run_source_events"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inbox_source_event_target_uniq" ON "inbox_events" ("target_run_id", "source_event_id") WHERE "source_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_event_delivery_matches" (
  "delivery_id" integer NOT NULL REFERENCES "inbox_events"("id") ON DELETE CASCADE,
  "subscription_id" uuid NOT NULL REFERENCES "run_event_subscriptions"("id") ON DELETE CASCADE,
  "matched_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("delivery_id", "subscription_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_event_delivery_matches_subscription_idx" ON "run_event_delivery_matches" ("subscription_id");
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "event_delivery_id" integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_messages_event_delivery_id_idx" ON "agent_messages" ("event_delivery_id") WHERE "event_delivery_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_inputs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "input_seq" bigint NOT NULL,
  "message_id" integer NOT NULL REFERENCES "agent_messages"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "assigned_turn_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "assigned_at" timestamptz,
  "completed_at" timestamptz,
  "cancelled_at" timestamptz,
  CONSTRAINT "run_inputs_kind_check" CHECK ("kind" IN ('user','event')),
  CONSTRAINT "run_inputs_status_check" CHECK ("status" IN ('pending','assigned','completed','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_inputs_run_seq_uniq" ON "run_inputs" ("run_id", "input_seq");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_inputs_message_uniq" ON "run_inputs" ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_inputs_ready_idx" ON "run_inputs" ("run_id", "status", "input_seq") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_turns" (
  "id" uuid PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "ordinal" bigint NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "state" text NOT NULL DEFAULT 'active',
  "input_manifest" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "backend_resume_before" text,
  "backend_resume_after" text,
  "execution_generation" integer NOT NULL DEFAULT 1,
  "result" jsonb,
  "checkpoint" jsonb,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
ALTER TABLE "run_turns" ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_turns_run_ordinal_uniq" ON "run_turns" ("run_id", "ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_turns_unfinished_idx" ON "run_turns" ("run_id") WHERE "state" IN ('active','running');
--> statement-breakpoint
