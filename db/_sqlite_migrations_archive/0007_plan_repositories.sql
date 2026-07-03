-- 0007_plan_repositories: plans become many-to-many with repositories, and
-- tasks pin to a specific repository within their plan's set.
--
-- Resolution rules used by the agent (lib/repo.ts):
--   - task.repo_id is the source of truth at session start.
--   - On task creation: if the plan has exactly one repo, the task inherits
--     it; if the plan has multiple, the caller must specify repo_id.
--   - Sessions record the resolved repo on their agent_sessions.repo_id row.

CREATE TABLE IF NOT EXISTS plan_repositories (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, repo_id)
);
CREATE INDEX IF NOT EXISTS plan_repos_repo_idx ON plan_repositories(repo_id);

-- Backfill: every plan with a (legacy) single repo_id becomes one row here.
INSERT OR IGNORE INTO plan_repositories (plan_id, repo_id, position)
SELECT id, repo_id, 0 FROM plans WHERE repo_id IS NOT NULL;

-- Tasks gain a repo pointer (nullable until backfilled below).
ALTER TABLE tasks ADD COLUMN repo_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_repo_idx ON tasks(repo_id);

-- Backfill task.repo_id from its plan's repository when the plan has exactly
-- one. Plans with multiple repos require an explicit task.repo_id.
UPDATE tasks SET repo_id = (
  SELECT pr.repo_id FROM plan_repositories pr
  WHERE pr.plan_id = tasks.plan_id
  GROUP BY pr.plan_id
  HAVING COUNT(*) = 1
);

-- Now drop the legacy single-repo column from plans (SQLite >= 3.35).
-- The index on it must go first or DROP COLUMN errors with
-- "error in index plans_repo_idx after drop column".
DROP INDEX IF EXISTS plans_repo_idx;
ALTER TABLE plans DROP COLUMN repo_id;
