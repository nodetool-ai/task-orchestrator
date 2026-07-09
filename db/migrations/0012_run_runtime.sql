-- Persisted run placement (docs/nested-machine-dispatch.md): WHERE a run's turns
-- execute — 'server' (the in-process lightweight loop on the web process) or
-- 'worker' (a detached process/container/Machine). Decided ONCE by
-- resolvePlacement() at create time and honored by dispatchRun, replacing the
-- per-dispatch env-predicate re-derivation that let run 131 be woken into a Fly
-- worker where the lightweight loop can't run. Default 'worker' backfills every
-- existing row onto the worker path (the pre-change behavior for non-lightweight
-- runs); lightweight runs re-resolve to 'server' on their next create.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "runtime" text NOT NULL DEFAULT 'worker';
