// Each test file runs in its own fork (pool: "forks"). Give each fork an
// isolated Postgres schema so parallel files don't collide on the singleton db.
// DATABASE_URL points at a throwaway Postgres (docker: postgres:16 on :5433);
// override via env in CI. Set before any module imports the db singleton so the
// search_path is picked up on first connect.
process.env.DATABASE_URL ??= "postgres://postgres:devpw@localhost:5433/taskorch";
// Unique per fork by default (parallel isolation); allow an explicit override
// for pinning a schema in CI / local debugging.
process.env.TASK_ORCH_PG_SCHEMA ??= `t_${process.pid}_${Date.now().toString(36)}`;

// Worker dispatch is HTTP-only: every spawn path mints a run-scoped token
// against TASK_ORCH_WORKER_API_URL (or NEXTAUTH_URL). Give the suite a
// deterministic base URL + signing secret so dispatch-env construction works
// everywhere; individual tests override/delete as needed.
process.env.TASK_ORCH_WORKER_API_URL ??= "http://orchestrator.test:3000";
process.env.TASK_ORCH_WORKER_API_SECRET ??= "vitest-worker-secret";

// Lightweight tier default: run turns IN-PROCESS across the suite. The production
// default is 'child' (a memory-capped local Node child), but unit tests drive
// turns synchronously in-process (resumeServerRun / append) and stub the model
// loop; spawning a real child would fork a process no test controls. Tests that
// specifically exercise the 'child' routing set TASK_ORCH_LIGHTWEIGHT_ISOLATION
// = "child" themselves (and inject dispatchRun's spawn seam so nothing forks).
process.env.TASK_ORCH_LIGHTWEIGHT_ISOLATION ??= "inprocess";

// Migrate + seed the fork's schema before any test runs.
const { initDb } = await import("./db");
await initDb();

export {};
