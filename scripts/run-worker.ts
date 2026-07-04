#!/usr/bin/env node
// scripts/run-worker.ts
//
// Detached run worker (M1). Spawned by lib/run-dispatch's defaultSpawn — usually
// inside a transient `systemd-run --user --scope` unit — so a `systemctl restart`
// of the web service can't signal it. It drives one already-created (and claimed)
// run to completion via driveDispatchedRun, then exits.
//
// Mirrors scripts/pipe.ts: load dotenv BEFORE importing any lib/* or ../db so env
// is set when the DB initialises and migrations run.

import { config } from "dotenv";
config({ path: ".env.local" });

import { driveDispatchedRun } from "../lib/runs";
import { startWorkerLogFlusher } from "../lib/runner/worker-log-store";

async function main() {
  const runId = parseInt(process.argv[2] ?? "", 10);
  if (!Number.isFinite(runId)) {
    console.error("[run-worker] usage: run-worker <runId>");
    process.exit(2);
  }

  // Ship the worker's runner.log off the ephemeral Fly volume into Postgres so
  // its debugging history survives the Machine + volume being destroyed. The
  // Fly entrypoint tee's all worker stdout/stderr to $SESSION_ROOT/logs/runner.log;
  // only start the flusher inside a worker (TASK_ORCH_INSIDE_WORKER) with a
  // SESSION_ROOT set — i.e. the case where that tee file actually exists.
  const sessionRoot = process.env.SESSION_ROOT;
  const logPath = sessionRoot ? `${sessionRoot}/logs/runner.log` : null;
  let stopLogFlusher: (() => Promise<void>) | null = null;
  if (logPath && process.env.TASK_ORCH_INSIDE_WORKER) {
    try {
      stopLogFlusher = startWorkerLogFlusher(runId, logPath);
    } catch (e) {
      // A log-capture failure must never stop us from driving the run.
      console.error("[run-worker] failed to start log flusher:", e);
    }
  }

  let exitCode = 0;
  try {
    await driveDispatchedRun(runId);
  } catch (e) {
    console.error("[run-worker] fatal:", e instanceof Error ? e.stack : e);
    exitCode = 1;
  } finally {
    // Terminal flush of runner.log — wraps BOTH the success and the catch path
    // so the last bytes land regardless of how the run ended. Runs BEFORE
    // process.exit (which would otherwise terminate before this awaited flush).
    if (stopLogFlusher) await stopLogFlusher().catch(() => {});
  }
  process.exit(exitCode);
}

void main();
