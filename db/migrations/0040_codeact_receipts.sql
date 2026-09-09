-- CodeAct executions and correlated host-operation receipts. An execution is
-- never reconstructed by replaying source; recovery reads these records and
-- reconciles individual subcalls instead.
CREATE TABLE IF NOT EXISTS "codeact_executions" (
  "execution_id" uuid PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "source_sha256" text NOT NULL,
  "status" text NOT NULL,
  "receipt" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codeact_executions_run_started_idx" ON "codeact_executions" ("run_id", "started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "codeact_subcalls" (
  "subcall_id" uuid PRIMARY KEY NOT NULL,
  "execution_id" uuid NOT NULL REFERENCES "codeact_executions"("execution_id") ON DELETE CASCADE,
  "operation" text NOT NULL,
  "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL,
  "result" jsonb,
  "error" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codeact_subcalls_execution_started_idx" ON "codeact_subcalls" ("execution_id", "started_at");
