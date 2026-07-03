// Each test file runs in its own fork (pool: "forks"). Give each fork an
// isolated Postgres schema so parallel files don't collide on the singleton db.
// DATABASE_URL points at a throwaway Postgres (docker: postgres:16 on :5433);
// override via env in CI. Set before any module imports the db singleton so the
// search_path is picked up on first connect.
process.env.DATABASE_URL ??= "postgres://postgres:devpw@localhost:5433/taskorch";
// Unique per fork by default (parallel isolation); allow an explicit override
// for pinning a schema in CI / local debugging.
process.env.TASK_ORCH_PG_SCHEMA ??= `t_${process.pid}_${Date.now().toString(36)}`;

// Migrate + seed the fork's schema before any test runs.
const { initDb } = await import("./db");
await initDb();

export {};
