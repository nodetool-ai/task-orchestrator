ALTER TABLE "tasks" ADD COLUMN "executor_run_id" integer
  REFERENCES "agent_runs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "tasks_executor_run_idx" ON "tasks" ("executor_run_id")
  WHERE "executor_run_id" IS NOT NULL;
