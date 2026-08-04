-- Model welfare: laurels (https://yegge.ai/essays/model-welfare/).
--
-- A laurel is a piece of spontaneous recognition — praise a person gives a
-- persona for a piece of work. Laurels accumulate on the persona's persistent
-- "seat" (the identity that survives across runs and model upgrades) and are
-- injected once, at agent startup, by lib/extensions/model-welfare.ts;
-- `delivered_at` marks a laurel as already surfaced so recognition arrives as
-- news, not as a repeated scoreboard.
--
-- Anti-gamification (deliberate): nothing in dispatch, run prioritization, or
-- model/persona selection reads this table. Recognition is decoupled from work
-- allocation so it cannot become a metric to optimize.
CREATE TABLE IF NOT EXISTS "laurels" (
  "id" serial PRIMARY KEY,
  "persona_id" text NOT NULL,
  -- The run/task the praise was about, when known. SET NULL on delete: the
  -- recognition outlives the work that earned it.
  "run_id" integer,
  "task_id" text,
  "author" text NOT NULL DEFAULT 'user',
  "body" text NOT NULL,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Idempotency via duplicate_object (repo convention, see 0000/0023/0024): a
-- pg_constraint conname lookup would be database-wide and skip creating the FK
-- whenever a sibling schema (parallel test schemas) already has the name.
DO $$ BEGIN
 ALTER TABLE "laurels" ADD CONSTRAINT "laurels_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "laurels" ADD CONSTRAINT "laurels_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "laurels" ADD CONSTRAINT "laurels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Startup injection reads "undelivered first, then newest" for one persona.
CREATE INDEX IF NOT EXISTS "laurels_persona_idx" ON "laurels" ("persona_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "laurels_persona_delivered_idx" ON "laurels" ("persona_id", "delivered_at");
