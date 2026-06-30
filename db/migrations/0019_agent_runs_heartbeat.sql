-- A run writes heartbeat_at periodically while a turn is executing. A run left
-- in an active status ('running'/'preparing'/'pushing'/'opening_pr') whose
-- heartbeat has gone stale is provably orphaned — the process that owned it
-- crashed (e.g. OOM-killed) without landing the run in a terminal/idle status.
-- reconcileOrphanedRuns() uses this to self-heal on boot; the append guard uses
-- it to take over a stale run on the next message. Multi-process safe: a run
-- genuinely live in another process keeps its heartbeat fresh.
ALTER TABLE agent_runs ADD COLUMN heartbeat_at INTEGER;
