-- Environments generalize box_templates across docker/fly/box (spec
-- 2026-07-18-environments-design.md). One row = one build/artifact per
-- provider, versioned by worker SHA. The partial unique index is the
-- per-provider single-flight build lock.
CREATE TABLE IF NOT EXISTS "environments" (
  "id" serial PRIMARY KEY,
  "provider" text NOT NULL,
  "worker_sha" text NOT NULL,
  "state" text NOT NULL DEFAULT 'building',
  "box_id" text,
  "image" text,
  "detail" text,
  "error" text,
  "triggering_run_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ready_at" timestamp with time zone
);
--> statement-breakpoint
INSERT INTO "environments" ("provider", "worker_sha", "state", "box_id", "error", "triggering_run_id", "created_at", "ready_at")
  SELECT 'box', "worker_sha", "state", "box_id", "error", "triggering_run_id", "created_at", "ready_at"
  FROM "box_templates" WHERE "state" IN ('ready', 'superseded', 'failed');
--> statement-breakpoint
DROP TABLE IF EXISTS "box_templates";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_live_idx"
  ON "environments" ("provider", "worker_sha")
  WHERE "state" IN ('building', 'ready');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_state_idx" ON "environments" ("state");
