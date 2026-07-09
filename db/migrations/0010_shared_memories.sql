ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "model_provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "model_id" text DEFAULT 'claude-sonnet-4-6' NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memories" (
  "id" serial PRIMARY KEY NOT NULL,
  "scope" text DEFAULT 'global' NOT NULL,
  "scope_key" text,
  "body" text NOT NULL,
  "keywords" text DEFAULT '[]' NOT NULL,
  "author" text DEFAULT 'agent' NOT NULL,
  "created_by_run_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memories" ADD CONSTRAINT "memories_created_by_run_id_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "agent_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_scope_idx" ON "memories" USING btree ("scope","scope_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_updated_idx" ON "memories" USING btree ("updated_at");
