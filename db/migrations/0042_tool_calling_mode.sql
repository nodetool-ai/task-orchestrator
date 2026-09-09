-- Persist the rollout decision so resumes and retries never change tool mode.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "tool_calling_mode" text NOT NULL DEFAULT 'codeact';
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tool_calling_mode_check" CHECK ("tool_calling_mode" IN ('direct', 'codeact'));
