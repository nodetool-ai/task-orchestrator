-- @migration-mode: no-transaction
--
-- 0009_agent_messages: fold chats + chat_messages into agent_runs +
-- agent_messages, the new single conversation primitive.
--
-- Why no-transaction: the migration relaxes agent_runs.task_id from
-- NOT NULL to nullable via a SQLite table-recreate, which requires
-- toggling `PRAGMA foreign_keys` (a no-op inside transactions). We
-- run the whole file outside the runner's auto-tx and use explicit
-- BEGIN/COMMIT below so the body is still atomic.
--
-- Backfill rules:
--   • Each chats row becomes an agent_runs row with goal='<chat>',
--     tools_profile='orchestrator,repo_write', cwd_strategy='none',
--     status='idle', task_id=NULL. We persist the old chat id in
--     agent_runs.legacy_chat_id so future /chat/[id] redirects can
--     resolve the new run.
--   • Each chat_messages row becomes an agent_messages row in the
--     same chronological order, mapped via legacy_chat_id.
--   • Each existing agent_events row becomes an agent_messages row:
--       - type='agent' (payload is an SDK envelope): role derives
--         from envelope.type — 'assistant' → 'agent', 'user' →
--         'tool', everything else (system/result) → 'system'.
--         Content is the envelope.message.content blocks where
--         present, else a one-element array containing the raw
--         envelope.
--       - Any other type (status/shell/shell_out/worktree/pr/stderr/
--         warning/resume/prompt/pr_merged/...): role='system',
--         content is a single-element JSON array with
--         {type:<event_type>, ...payload}.
--
-- agent_events is intentionally NOT dropped here — it stays in shadow
-- for one release so the existing /sessions UI keeps rendering. A
-- follow-up migration drops it once the unified /runs UI is validated.
-- chats and chat_messages ARE dropped at the end of this migration.

PRAGMA foreign_keys = OFF;

BEGIN;

-- ─── 1. agent_messages table ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE INDEX IF NOT EXISTS agent_messages_run_idx ON agent_messages(run_id);
CREATE INDEX IF NOT EXISTS agent_messages_run_id_ord_idx ON agent_messages(run_id, id);

-- ─── 2. Add legacy_chat_id + relax task_id on agent_runs ───────────

ALTER TABLE agent_runs ADD COLUMN legacy_chat_id INTEGER;
CREATE INDEX IF NOT EXISTS agent_runs_legacy_chat_idx ON agent_runs(legacy_chat_id);

-- Table-recreate to drop NOT NULL from task_id. All other columns are
-- preserved exactly. FKs from other tables (agent_events.run_id, future
-- agent_messages.run_id) keep working because SQLite resolves them by
-- table name and FKs are disabled during the swap.
CREATE TABLE agent_runs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT,
  branch TEXT,
  worktree_path TEXT,
  pr_url TEXT,
  error TEXT,
  total_cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  sdk_session_id TEXT,
  resume_of INTEGER,
  repo_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  goal TEXT NOT NULL DEFAULT '<implement>',
  tools_profile TEXT NOT NULL DEFAULT 'orchestrator,repo_write',
  cwd_strategy TEXT NOT NULL DEFAULT 'worktree',
  parent_run_id INTEGER REFERENCES agent_runs_new(id),
  budget_max_turns INTEGER,
  budget_max_usd REAL,
  budget_max_seconds INTEGER,
  outcome TEXT,
  title TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  legacy_chat_id INTEGER,
  started_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  completed_at INTEGER
);

INSERT INTO agent_runs_new (
  id, task_id, status, model, branch, worktree_path, pr_url, error,
  total_cost_usd, input_tokens, output_tokens, sdk_session_id, resume_of,
  repo_id, goal, tools_profile, cwd_strategy, parent_run_id,
  budget_max_turns, budget_max_usd, budget_max_seconds, outcome, title,
  user_id, legacy_chat_id, started_at, completed_at
)
SELECT
  id, task_id, status, model, branch, worktree_path, pr_url, error,
  total_cost_usd, input_tokens, output_tokens, sdk_session_id, resume_of,
  repo_id, goal, tools_profile, cwd_strategy, parent_run_id,
  budget_max_turns, budget_max_usd, budget_max_seconds, outcome, title,
  user_id, legacy_chat_id, started_at, completed_at
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;

CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs(status);
CREATE INDEX IF NOT EXISTS agent_runs_repo_idx ON agent_runs(repo_id);
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs(user_id);
CREATE INDEX IF NOT EXISTS agent_runs_legacy_chat_idx ON agent_runs(legacy_chat_id);

-- ─── 3. Backfill chats → agent_runs ─────────────────────────────────

INSERT INTO agent_runs (
  status, model, sdk_session_id, repo_id, goal, tools_profile,
  cwd_strategy, title, user_id, total_cost_usd, input_tokens,
  output_tokens, legacy_chat_id, started_at, completed_at
)
SELECT
  'idle',
  c.model,
  c.sdk_session_id,
  c.repo_id,
  '<chat>',
  'orchestrator,repo_write',
  'none',
  c.title,
  c.user_id,
  c.total_cost_usd,
  c.input_tokens,
  c.output_tokens,
  c.id,
  c.created_at,
  c.updated_at
FROM chats c;

-- ─── 4. Backfill chat_messages → agent_messages ────────────────────

INSERT INTO agent_messages (run_id, role, content, created_at)
SELECT
  r.id,
  CASE cm.role
    WHEN 'assistant'   THEN 'agent'
    WHEN 'tool_result' THEN 'tool'
    ELSE cm.role
  END,
  cm.content,
  cm.created_at
FROM chat_messages cm
JOIN agent_runs r ON r.legacy_chat_id = cm.chat_id
ORDER BY cm.id;

-- ─── 5. Backfill agent_events → agent_messages ─────────────────────

-- 5a. Events of type 'agent' carry an SDK message envelope as payload.
INSERT INTO agent_messages (run_id, role, content, created_at)
SELECT
  e.run_id,
  CASE json_extract(e.payload, '$.type')
    WHEN 'assistant' THEN 'agent'
    WHEN 'user'      THEN 'tool'
    ELSE 'system'
  END,
  CASE
    WHEN json_extract(e.payload, '$.type') IN ('assistant', 'user')
      AND json_extract(e.payload, '$.message.content') IS NOT NULL
      THEN json_extract(e.payload, '$.message.content')
    ELSE json_array(json(e.payload))
  END,
  e.created_at
FROM agent_events e
WHERE e.type = 'agent';

-- 5b. Non-'agent' events become role='system' messages whose content is
-- a one-element JSON array with {type, ...payload}.
INSERT INTO agent_messages (run_id, role, content, created_at)
SELECT
  e.run_id,
  'system',
  json_array(
    CASE
      WHEN json_valid(e.payload) AND json_type(e.payload) = 'object'
        THEN json_set(e.payload, '$.type', e.type)
      ELSE json_object('type', e.type, 'raw', e.payload)
    END
  ),
  e.created_at
FROM agent_events e
WHERE e.type <> 'agent';

-- ─── 6. Drop chats + chat_messages ──────────────────────────────────

DROP INDEX IF EXISTS chat_messages_chat_idx;
DROP TABLE IF EXISTS chat_messages;

DROP INDEX IF EXISTS chats_user_idx;
DROP INDEX IF EXISTS chats_updated_idx;
DROP INDEX IF EXISTS chats_repo_idx;
DROP TABLE IF EXISTS chats;

COMMIT;

PRAGMA foreign_keys = ON;
