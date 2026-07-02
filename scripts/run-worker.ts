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

async function main() {
  const runId = parseInt(process.argv[2] ?? "", 10);
  if (!Number.isFinite(runId)) {
    console.error("[run-worker] usage: run-worker <runId>");
    process.exit(2);
  }
  try {
    await driveDispatchedRun(runId);
    process.exit(0);
  } catch (e) {
    console.error("[run-worker] fatal:", e instanceof Error ? e.stack : e);
    process.exit(1);
  }
}

void main();
