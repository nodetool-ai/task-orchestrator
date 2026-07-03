-- Final container state for detached run workers, written by the worker monitor
-- when a container dies: the tail of its docker logs and its exit code. Lets a
-- run be debugged after its container is removed.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "worker_log" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "worker_exit_code" integer;
