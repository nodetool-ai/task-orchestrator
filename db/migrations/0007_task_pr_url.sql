-- Explicit, tool-set PR link for a task (set_task_pr). Authoritative once
-- populated; lib/repo.ts falls back to the session-derived "latest run's PR"
-- for tasks whose implementor hasn't called the tool yet.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pr_url" text;
