#!/usr/bin/env node
// scripts/run-lightweight-child.ts
//
// Entry point for the LIGHTWEIGHT server-tier child (runtime='server', isolation
// 'child'; see lib/run-dispatch's spawnLightweightChild). This is what a `<chat>`
// run started from the /runs page dispatches to.
//
// Unlike scripts/run-worker.ts — a WebSocket-only worker that drives its run over
// a channel and never touches Postgres — this child stays ON the control plane's
// DB path. dispatchRun claims the run 'preparing' and spawns this process with the
// server's full env (DATABASE_URL retained, NO worker channel identity), memory-
// capped via --max-old-space-size but otherwise the same process as an in-process
// server turn. It drives its already-claimed run straight through
// driveDispatchedRun, which routes a `<chat>` to the long-lived driveChatSession
// loop (one turn per inbound user message; the loop adopts the 'preparing' claim
// and releases it when the chat idles out), then exits.
//
// It runs on the server host, which has the full repo + node_modules + tsx, so
// importing lib/runs (and the Postgres client) here is expected — it must NOT be
// bundled into the lean standalone worker image, which is why this is a separate
// entry from run-worker.ts.
//
// Mirrors scripts/pipe.ts: load dotenv BEFORE importing any lib/* or ../db so env
// is set when the DB initialises and migrations run.

import { config } from "dotenv";
config({ path: ".env.local" });

import { driveDispatchedRun } from "../lib/runs";
import { installProcessSafetyNet } from "../lib/transient-errors";
import { createLogger } from "../lib/worker/log";

const log = createLogger("run-lightweight-child");

// A transient reset of a detached DB socket (LISTEN/NOTIFY) arrives as an
// unhandled rejection and would otherwise crash the whole run. Swallow those;
// real bugs still exit non-zero.
installProcessSafetyNet({ label: "run-lightweight-child" });

async function main() {
  const runId = parseInt(process.argv[2] ?? "", 10);
  if (!Number.isFinite(runId)) {
    console.error("[run-lightweight-child] usage: run-lightweight-child <runId>");
    process.exit(2);
  }

  log.info("lightweight child starting", { runId, transport: "db", pid: process.pid });

  let exitCode = 0;
  try {
    // The run is already claimed 'preparing' by dispatchRun; driveDispatchedRun
    // adopts that claim, drives the turn(s), and releases it (driveChatSession's
    // finally for a chat, the single-turn release for other goals).
    await driveDispatchedRun(runId);
    log.info("lightweight child finished", { runId });
  } catch (e) {
    log.error("lightweight child fatal", {
      runId,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
    exitCode = 1;
  }
  process.exit(exitCode);
}

void main();
