CREATE TABLE IF NOT EXISTS "acceptance_criteria" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"type" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text,
	"plan_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"model" text,
	"branch" text,
	"worktree_path" text,
	"pr_url" text,
	"error" text,
	"total_cost_usd" real,
	"input_tokens" integer,
	"output_tokens" integer,
	"sdk_session_id" text,
	"resume_of" integer,
	"repo_id" text,
	"goal" text DEFAULT '<implement>' NOT NULL,
	"thinking_level" text,
	"tools_profile" text DEFAULT 'orchestrator,repo_write' NOT NULL,
	"cwd_strategy" text DEFAULT 'worktree' NOT NULL,
	"parent_run_id" integer,
	"budget_max_turns" integer,
	"budget_max_usd" real,
	"budget_max_seconds" integer,
	"outcome" text,
	"title" text,
	"user_id" integer,
	"persona_id" text,
	"legacy_chat_id" integer,
	"planning_stage" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"worker_scope" text,
	"worker_pid" integer,
	"cancel_requested" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" text,
	"task_id" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_owner_xor" CHECK (("attachments"."plan_id" IS NOT NULL) <> ("attachments"."task_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "persona_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_id" text NOT NULL,
	"scope" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "personas" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"system_prompt" text NOT NULL,
	"thinking_level" text,
	"tools_profile" text NOT NULL,
	"skill_paths" text DEFAULT '[]' NOT NULL,
	"budget_max_turns" integer,
	"budget_max_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_repositories" (
	"plan_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "plan_repositories_plan_id_repo_id_pk" PRIMARY KEY("plan_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"owner" text,
	"body" text DEFAULT '' NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"remote" text,
	"local_path" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_dependencies" (
	"task_id" text NOT NULL,
	"depends_on_id" text NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_id_pk" PRIMARY KEY("task_id","depends_on_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'todo' NOT NULL,
	"plan_id" text NOT NULL,
	"assignee" text,
	"body" text DEFAULT '' NOT NULL,
	"estimate" text,
	"tags" text DEFAULT '[]' NOT NULL,
	"repo_id" text,
	"attached_run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachments" ADD CONSTRAINT "attachments_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "persona_memories" ADD CONSTRAINT "persona_memories_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_repositories" ADD CONSTRAINT "plan_repositories_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_repositories" ADD CONSTRAINT "plan_repositories_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_id_tasks_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ac_task_idx" ON "acceptance_criteria" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_events_run_idx" ON "agent_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_events_created_idx" ON "agent_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_events_run_id" ON "agent_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_messages_run_idx" ON "agent_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_messages_run_id_ord_idx" ON "agent_messages" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_task_idx" ON "agent_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_plan_idx" ON "agent_runs" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_repo_idx" ON "agent_runs" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_parent_idx" ON "agent_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_user_idx" ON "agent_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_legacy_chat_idx" ON "agent_runs" USING btree ("legacy_chat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_persona_idx" ON "agent_runs" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_prefix_idx" ON "api_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_plan_idx" ON "attachments" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_task_idx" ON "attachments" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_threads_channel_external_uniq" ON "channel_threads" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_threads_run_idx" ON "channel_threads" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "persona_memories_persona_idx" ON "persona_memories" USING btree ("persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "persona_memories_persona_scope_uniq" ON "persona_memories" USING btree ("persona_id","scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_repos_repo_idx" ON "plan_repositories" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plans_state_idx" ON "plans" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_deps_depends_idx" ON "task_dependencies" USING btree ("depends_on_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_notes_task_idx" ON "task_notes" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_plan_idx" ON "tasks" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_state_idx" ON "tasks" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_assignee_idx" ON "tasks" USING btree ("assignee");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_repo_idx" ON "tasks" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");