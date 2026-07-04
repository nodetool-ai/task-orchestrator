CREATE TABLE IF NOT EXISTS "runner_instances" (
	"run_id" integer PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'fly' NOT NULL,
	"fly_app" text,
	"machine_id" text,
	"volume_id" text,
	"region" text,
	"state" text DEFAULT 'creating' NOT NULL,
	"repo_path" text DEFAULT '/mnt/session/repo' NOT NULL,
	"claude_path" text DEFAULT '/mnt/session/claude' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_suspended_at" timestamp with time zone,
	"archived_uri" text,
	CONSTRAINT "runner_instances_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
COMMENT ON TABLE "runner_instances" IS 'Provider runtime mapping for detached run workers. Runner lifecycle event types: runner_created, runner_started, repo_cloned, claude_started, runner_suspended, runner_resumed, runner_cold_recovered, runner_failed.';
--> statement-breakpoint
ALTER TABLE "runner_instances" ENABLE ROW LEVEL SECURITY;
