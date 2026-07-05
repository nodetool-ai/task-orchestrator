-- Per-run agent backend selection: 'pi' | 'claude', NULL = deployment default
-- (TASK_ORCH_AGENT_BACKEND). Picked in the run-starting UI/API/CLI.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "backend" text;
