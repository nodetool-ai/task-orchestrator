-- One canonical "attached run" per task: the single worktree session that
-- carries a task's implement / chat / merge turns. NULL until the first
-- interaction (the Agent button or the task chat box) creates it.
-- ON DELETE SET NULL so deleting the run just clears the pointer.
ALTER TABLE tasks ADD COLUMN attached_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL;
