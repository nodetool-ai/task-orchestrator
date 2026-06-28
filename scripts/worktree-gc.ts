#!/usr/bin/env node
// scripts/worktree-gc.ts
//
// One-shot worktree garbage collection. The in-server hourly sweep
// (instrumentation.ts) is disabled in production because Next drops the
// /* webpackIgnore */ on the dynamic import and the prod bundle can't resolve
// lib/worktree-gc at boot. This script runs the same sweep out-of-process,
// driven by a systemd user timer (see scripts/install-gc-timer.sh).
//
// Mirrors cli.ts / pipe.ts: load dotenv BEFORE importing any lib/* or @/db so
// env (TASK_ORCH_DB, thresholds) is set when the DB initialises.

import { config } from "dotenv";
config({ path: ".env.local" });

import "../db"; // triggers migrations on import, same as the web app
import { runWorktreeGcOnce } from "../lib/worktree-gc";

async function main() {
  const res = await runWorktreeGcOnce();
  console.log(
    `[worktree-gc] scanned=${res.scanned} removed=${res.removed} errors=${res.errors}`
  );
  for (const r of res.removals) {
    console.log(
      `[worktree-gc] removed run ${r.runId} after ${r.idleDays.toFixed(1)}d idle: ${r.worktreePath}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[worktree-gc] fatal:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
