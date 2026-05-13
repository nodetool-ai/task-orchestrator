-- 0006_repositories: first-class git repositories.
--
-- A repository is a target codebase the orchestrator can drive: a worktree
-- root for sessions, a cwd for chat agents, and (later) the surface a
-- verifier evaluates PRs against. Plans, chats and agent sessions point at
-- one. Existing rows are backfilled to a seeded R-default row whose
-- local_path is later synced from TASK_ORCH_TARGET_REPO at app boot.

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  remote TEXT,
  local_path TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

-- Seed the default repository. local_path is a placeholder; db/index.ts will
-- overwrite it from TASK_ORCH_TARGET_REPO at app boot if that env var is set.
INSERT OR IGNORE INTO repositories (id, name, local_path, default_branch, description)
VALUES ('R-default', 'default', NULL, 'main', 'Auto-seeded default repository.');

ALTER TABLE plans ADD COLUMN repo_id TEXT REFERENCES repositories(id);
UPDATE plans SET repo_id = 'R-default' WHERE repo_id IS NULL;
CREATE INDEX IF NOT EXISTS plans_repo_idx ON plans(repo_id);

ALTER TABLE chats ADD COLUMN repo_id TEXT REFERENCES repositories(id);
UPDATE chats SET repo_id = 'R-default' WHERE repo_id IS NULL;
CREATE INDEX IF NOT EXISTS chats_repo_idx ON chats(repo_id);

ALTER TABLE agent_sessions ADD COLUMN repo_id TEXT REFERENCES repositories(id);
UPDATE agent_sessions SET repo_id = 'R-default' WHERE repo_id IS NULL;
CREATE INDEX IF NOT EXISTS agent_sessions_repo_idx ON agent_sessions(repo_id);
