-- The task's canonical git branch. Reserved when the first implement run is
-- created (adopting a legacy attached-run branch when one exists, else
-- claude/<taskid>) and reused by every later run on the task, so all agent
-- work on a task accumulates on ONE branch / ONE PR.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "branch" text;
