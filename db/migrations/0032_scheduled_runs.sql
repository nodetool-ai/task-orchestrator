ALTER TABLE "tasks" ALTER COLUMN "plan_id" DROP NOT NULL;
--> statement-breakpoint
CREATE TABLE "run_schedules" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "prompt" text NOT NULL,
  "repo_id" text NOT NULL REFERENCES "repositories"("id") ON DELETE RESTRICT,
  "base_branch" text,
  "kind" text NOT NULL,
  "run_at" timestamptz,
  "interval_seconds" integer,
  "cron_expression" text,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "enabled" boolean NOT NULL DEFAULT true,
  "next_run_at" timestamptz,
  "last_scheduled_at" timestamptz,
  "persona_id" text REFERENCES "personas"("id") ON DELETE SET NULL,
  "model" text,
  "tools_profile" text,
  "auto_merge" boolean NOT NULL DEFAULT false,
  "budget_max_turns" integer,
  "budget_max_usd" real,
  "budget_max_seconds" integer,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "run_schedules_kind_check" CHECK (
    (kind = 'once' AND run_at IS NOT NULL AND interval_seconds IS NULL AND cron_expression IS NULL) OR
    (kind = 'interval' AND run_at IS NULL AND interval_seconds IS NOT NULL AND interval_seconds > 0 AND cron_expression IS NULL) OR
    (kind = 'cron' AND run_at IS NULL AND interval_seconds IS NULL AND cron_expression IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "run_schedules_due_idx" ON "run_schedules" ("enabled", "next_run_at") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "schedule_occurrences" (
  "id" serial PRIMARY KEY NOT NULL,
  "schedule_id" integer NOT NULL REFERENCES "run_schedules"("id") ON DELETE RESTRICT,
  "scheduled_for" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "schedule_occurrences_status_check" CHECK ("status" IN ('pending', 'launching', 'launched', 'skipped', 'failed')),
  CONSTRAINT "schedule_occurrences_schedule_time_unique" UNIQUE ("schedule_id", "scheduled_for")
);
--> statement-breakpoint
CREATE INDEX "schedule_occurrences_active_idx" ON "schedule_occurrences" ("schedule_id", "status");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "schedule_occurrence_id" integer REFERENCES "schedule_occurrences"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_schedule_occurrence_id_idx" ON "tasks" ("schedule_occurrence_id") WHERE "schedule_occurrence_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "auto_merge" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "schedule_occurrence_id" integer REFERENCES "schedule_occurrences"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_schedule_occurrence_id_idx" ON "agent_runs" ("schedule_occurrence_id") WHERE "schedule_occurrence_id" IS NOT NULL;
