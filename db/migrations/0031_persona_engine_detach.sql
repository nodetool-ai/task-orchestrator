-- A persona is WHO an agent is, not WHICH engine runs it.
--
-- model_provider/model_id/backend/thinking_level made the persona a second
-- source of truth for engine config, and a wrong pin was invisible until a turn
-- failed: the concierge pinned backend='pi' with an Anthropic model, so prod run
-- 190 died with "No API key found for anthropic" on a host authenticated for the
-- Claude backend. All four are per-run choices now, with the deployment defaults
-- (TASK_ORCH_AGENT_MODEL / TASK_ORCH_AGENT_BACKEND / TASK_ORCH_THINKING_LEVEL)
-- behind them. Existing agent_runs rows keep their own resolved model/backend
-- columns, so runs in flight are unaffected.
ALTER TABLE "personas" DROP COLUMN IF EXISTS "model_provider";
ALTER TABLE "personas" DROP COLUMN IF EXISTS "model_id";
ALTER TABLE "personas" DROP COLUMN IF EXISTS "backend";
ALTER TABLE "personas" DROP COLUMN IF EXISTS "thinking_level";
