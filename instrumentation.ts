// Next.js 13+ runtime hook: invoked once per process on first request /
// cold start.
//
// IMPORTANT — edge vs. node bundling: this file is compiled TWICE, once for the
// Node.js server and once for the edge/middleware runtime (this project ships a
// middleware.ts). Node-only dependencies (better-sqlite3 via lib/runs) must not
// leak into the edge bundle. Next.js inlines `process.env.NEXT_RUNTIME` at build
// time, so wrapping the node-only side effects in an `=== "nodejs"` *block* lets
// webpack fold the condition to `false` for the edge build and dead-code-strip
// the dynamic imports inside it (a bare early `!== "nodejs"` return does NOT get
// that treatment — webpack still collects `import()` dependencies that sit after
// the return, which pulls better-sqlite3 into the edge graph and fails the build).
//
// See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Boot recovery: self-heal runs orphaned by a previous process death (deploy
    // restart, crash, host reboot). Cheap and idempotent, so it runs on every
    // nodejs cold start regardless of feature flags. When TASK_ORCH_DETACHED_RUNS
    // is on, reconcileOrphanedRuns() re-dispatches resumable orphans to fresh
    // detached workers instead of failing them; with the flag off it keeps
    // today's behavior.
    //
    // A plain literal `import("./lib/runs")` (no /* webpackIgnore */, no variable
    // indirection) is required so webpack BUNDLES lib/runs into a server chunk
    // that actually resolves in the prod build. A webpackIgnore'd specifier
    // compiles to a runtime `import("./lib/runs")` with no counterpart on disk
    // under .next/server and throws ERR_MODULE_NOT_FOUND at boot, silently
    // no-op'ing the reconcile in production. The try/catch keeps a reconcile
    // *runtime* error from crashing server boot.
    try {
      const runsMod = await import("./lib/runs");
      runsMod.reconcileOrphanedRuns();
    } catch (err) {
      console.error("[instrumentation] boot reconcile failed:", err);
    }

    // Optional hourly worktree-GC sweep. Kept behind the env flag AND a
    // webpackIgnore'd variable specifier: production doesn't set the flag, so the
    // unresolved-in-prod-bundle import is never reached. Run it from a cron /
    // one-shot script if the sweep is needed in production.
    if (process.env.TASK_ORCH_WORKTREE_GC) {
      const modPath = "./lib/worktree-gc";
      const mod = (await import(/* webpackIgnore: true */ modPath)) as {
        startWorktreeGc: () => void;
      };
      mod.startWorktreeGc();
    }
  }
}
