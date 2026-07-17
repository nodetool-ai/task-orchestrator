-- db/migrations/0020_box_templates.sql
-- App-managed Box template registry (spec 2026-07-17-box-app-managed-template).
-- The partial unique index is the single-flight lock: at most one live
-- (building/ready) template per worker SHA.
CREATE TABLE IF NOT EXISTS "box_templates" (
  "id" serial PRIMARY KEY,
  "worker_sha" text NOT NULL,
  "repository" text NOT NULL,
  "state" text NOT NULL DEFAULT 'building',
  "box_id" text,
  "triggering_run_id" integer,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ready_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "box_templates_live_sha_idx"
  ON "box_templates" ("worker_sha")
  WHERE "state" IN ('building', 'ready');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "box_templates_state_idx" ON "box_templates" ("state");
