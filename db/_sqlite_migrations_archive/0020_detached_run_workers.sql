-- Detached run workers: identity + cross-process cancel + tail indexes.
ALTER TABLE agent_runs ADD COLUMN worker_scope TEXT;
ALTER TABLE agent_runs ADD COLUMN worker_pid INTEGER;
ALTER TABLE agent_runs ADD COLUMN cancel_requested INTEGER;
CREATE INDEX IF NOT EXISTS idx_agent_messages_run_id ON agent_messages (run_id, id);
-- Note: agent_events' FK column is named run_id in the DB (renamed from
-- session_id by migration 0008); the Drizzle field is `sessionId`.
CREATE INDEX IF NOT EXISTS idx_agent_events_run_id ON agent_events (run_id, id);
