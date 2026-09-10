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
    // Validate the selected runner before the best-effort recovery block. A
    // retired provider must fail server boot, not be reduced to a log line by
    // the recovery catch below.
    const configMod = await import("./lib/config");
    configMod.runnerProviderKind();
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
      // Postgres: migrations + seeding no longer run at import time (the client
      // connects lazily), so apply them here before anything touches the DB.
      const dbMod = await import("./db");
      await dbMod.initDb();
      const codeActMod = await import("./lib/codeact/receipts");
      await codeActMod.recoverOrphanedCodeActExecutions();
      // Runner-provider recovery can take minutes when an external API is slow.
      // Next.js holds every request (including /api/health) until register()
      // resolves, so only the schema-critical work above belongs on the boot
      // path. Preserve recovery ordering, but let the control plane serve while
      // it completes.
      void (async () => {
        const runsMod = await import("./lib/runs");
        const dispatchMod = await import("./lib/run-dispatch");
        const providerMod = await import("./lib/runner/provider");
        // Sweep the selected runner backend BEFORE reconcile. A worker that died
        // while the server was down may still be visible to Docker/Sprites: the sweep
        // applies the death policy so failures are visible rather than blindly
        // re-dispatched by heartbeat-only reconcile.
        await providerMod.getRunnerProvider().sweep().catch((e) => {
          console.error("[instrumentation] boot runner sweep failed:", e);
        });
        await dispatchMod.observeWorkerIncarnations().catch((e) => {
          console.error("[instrumentation] boot liveness observation failed:", e);
        });
        await runsMod.reconcileOrphanedRuns();
        const schedulesMod = await import("./lib/schedules");
        await schedulesMod.reconcileScheduleOccurrences().catch((e) => {
          console.error("[instrumentation] schedule recovery failed:", e);
        });
        // Start the pending-run pump only after boot recovery so those two full
        // reconciliation passes cannot overlap.
        dispatchMod.startPendingRunPump();
        // Re-adopt every active worker WebSocket channel after durable recovery.
        const channelMod = await import("./lib/worker-channel/controller");
        void channelMod.reconnectActiveChannels().catch((e) => {
          console.error("[instrumentation] worker channel re-adoption failed:", e);
        });
      })().catch((e) => {
        console.error("[instrumentation] background boot recovery failed:", e);
      });
    } catch (err) {
      console.error("[instrumentation] boot init/reconcile failed:", err);
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
