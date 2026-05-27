-- 0012_agent_runs_plan_id: scope chat runs to a plan.
--
-- Lets the /plans/[id] page launch a `<chat>` run that has the parent
-- plan in context. The agent can use the orchestrator MCP tools to
-- create/update/transition tasks under this plan, change the plan's
-- body, etc. Nullable so non-plan runs (existing implement runs,
-- task chats, free chats) are unaffected.

ALTER TABLE agent_runs ADD COLUMN plan_id TEXT
  REFERENCES plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_runs_plan_idx ON agent_runs(plan_id);
