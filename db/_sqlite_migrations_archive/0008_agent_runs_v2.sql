-- 0008_agent_runs_v2: rename agent_sessions to agent_runs and add the v2
-- schema (goal, tools_profile, cwd_strategy, parent_run_id, budgets, outcome,
-- title, user_id). The agent_events.session_id column is renamed to run_id;
-- SQLite (>= 3.26, with foreign_keys ON) automatically updates the FK target
-- when the parent table is renamed, so we only need to rename the column.
--
-- Backfill rules for existing rows:
--   - goal:          '<implement>' sentinel (real prompt is generated at
--                    run time from the task; we don't store it for legacy rows).
--   - tools_profile: 'orchestrator,repo_write' (today's behaviour).
--   - cwd_strategy:  'worktree' (today's behaviour).
--   - status:        completed → idle (resumable terminal); other values kept.
--
-- The status enum gains 'idle' and 'closed' but is validated in the app
-- layer, not by a CHECK constraint, to keep migrations forward-compatible.

ALTER TABLE agent_sessions RENAME TO agent_runs;

-- Indexes on the renamed table are auto-renamed by SQLite but the previous
-- names still reference the old table name in their identifier. Recreate the
-- indexes under sensible names; the old ones are dropped first.
DROP INDEX IF EXISTS agent_sessions_task_idx;
DROP INDEX IF EXISTS agent_sessions_status_idx;
DROP INDEX IF EXISTS agent_sessions_repo_idx;
CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs(status);
CREATE INDEX IF NOT EXISTS agent_runs_repo_idx ON agent_runs(repo_id);

-- Rename the FK column on agent_events. The FK target is updated automatically
-- by SQLite when the parent table is renamed (foreign_keys pragma is ON).
ALTER TABLE agent_events RENAME COLUMN session_id TO run_id;
DROP INDEX IF EXISTS agent_events_session_idx;
CREATE INDEX IF NOT EXISTS agent_events_run_idx ON agent_events(run_id);

-- New v2 columns. SQLite ADD COLUMN requires either a constant default or
-- nullability; we use constant defaults for the NOT NULL ones so existing
-- rows are filled in atomically.
ALTER TABLE agent_runs ADD COLUMN goal TEXT NOT NULL DEFAULT '<implement>';
ALTER TABLE agent_runs ADD COLUMN tools_profile TEXT NOT NULL DEFAULT 'orchestrator,repo_write';
ALTER TABLE agent_runs ADD COLUMN cwd_strategy TEXT NOT NULL DEFAULT 'worktree';
ALTER TABLE agent_runs ADD COLUMN parent_run_id INTEGER REFERENCES agent_runs(id);
ALTER TABLE agent_runs ADD COLUMN budget_max_turns INTEGER;
ALTER TABLE agent_runs ADD COLUMN budget_max_usd REAL;
ALTER TABLE agent_runs ADD COLUMN budget_max_seconds INTEGER;
ALTER TABLE agent_runs ADD COLUMN outcome TEXT;
ALTER TABLE agent_runs ADD COLUMN title TEXT;
ALTER TABLE agent_runs ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs(user_id);

-- Status backfill: existing 'completed' rows become 'idle' so the new
-- resumable-terminal semantics apply uniformly. Other statuses
-- (pending, running, failed, cancelled, ...) are left untouched.
UPDATE agent_runs SET status = 'idle' WHERE status = 'completed';
