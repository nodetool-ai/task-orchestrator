-- Per-persona agent backend default: 'pi' | 'claude', NULL = inherit the
-- deployment default (TASK_ORCH_AGENT_BACKEND). Set from the persona editor's
-- engine picker; a run with no explicit backend choice inherits this before
-- falling back to the deployment default.
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "backend" text;
