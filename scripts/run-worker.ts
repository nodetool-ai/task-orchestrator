#!/usr/bin/env node
// scripts/run-worker.ts
//
// Detached run worker (M1). Spawned by lib/run-dispatch's defaultSpawn — usually
// inside a transient `systemd-run --user --scope` unit — so a `systemctl restart`
// of the web service can't signal it. It drives one already-created (and claimed)
// run to completion via driveWorkerRun (over the WebSocket channel), then exits.
//
// Mirrors scripts/pipe.ts: load dotenv BEFORE importing any lib/* or ../db so env
// is set when the DB initialises and migrations run.

import { config } from "dotenv";
config({ path: ".env.local" });

import { config as appConfig } from "../lib/config";
import { driveWorkerRun, type WorkerDriverSession } from "../lib/worker-runtime/context";
import { insideWorker } from "../lib/runner/provider";
import { startWorkerLogFlusher } from "../lib/runner/worker-log-store";
import { installProcessSafetyNet } from "../lib/transient-errors";
import { startWorkerServer, type WorkerServer } from "../lib/worker-channel/worker-server";
import { createLogger } from "../lib/worker/log";

const log = createLogger("run-worker");

// A transient reset of a detached DB socket (LISTEN/NOTIFY, best-effort log
// flush) arrives as an unhandled rejection and would otherwise crash the whole
// run. Swallow those; real bugs still exit non-zero.
installProcessSafetyNet({ label: "run-worker" });

async function main() {
  const runId = parseInt(process.argv[2] ?? "", 10);
  if (!Number.isFinite(runId)) {
    console.error("[run-worker] usage: run-worker <runId>");
    process.exit(2);
  }

  log.info("worker starting", { runId, transport: "ws", pid: process.pid });

  // Ship the worker's runner.log off the ephemeral Fly volume into Postgres so
  // its debugging history survives the Machine + volume being destroyed. The
  // Fly entrypoint tee's all worker stdout/stderr to $SESSION_ROOT/logs/runner.log;
  // only start the flusher inside a worker (insideWorker(), which correctly
  // treats "0"/"false" as off) with a SESSION_ROOT set — i.e. the case where
  // that tee file actually exists.
  const sessionRoot = process.env.SESSION_ROOT;
  const logPath = sessionRoot ? `${sessionRoot}/logs/runner.log` : null;
  let stopLogFlusher: (() => Promise<void>) | null = null;

  const instanceId = appConfig.worker.channelInstanceId;
  const credential = appConfig.worker.channelCredential;
  const endpoint = appConfig.worker.channelEndpoint;
  if (!instanceId || !credential || !endpoint) {
    // The worker protocol is WebSocket-only (plan section 18). Dispatch injects
    // the channel identity, credential, and listen endpoint; without them the
    // worker has no way to reach the control plane and must fail fast rather
    // than fall back to Postgres or an HTTP API that no longer exists.
    console.error(
      "[run-worker] missing worker channel configuration " +
        "(TASK_ORCH_WORKER_INSTANCE_ID / TASK_ORCH_WORKER_CHANNEL_CREDENTIAL / " +
        "TASK_ORCH_WORKER_CHANNEL_ENDPOINT). Dispatch must inject the channel identity."
    );
    process.exit(2);
  }

  let exitCode = 0;
  let supervisor: WorkerServer | undefined;
  try {
    // WebSocket transport (plan section 13): the control plane pushes the
    // authoritative RunStart snapshot and all subsequent input over the channel.
    // Start the supervisor, wait for that snapshot, build the worker run context
    // from it, and drive the run without any Postgres or control-plane HTTP read.
    // The supervisor is closed (drained) in the finally below.
    supervisor = await startWorkerServer({ runId, instanceId, credential, endpoint });

    // Ship the tee'd runner.log over the CHANNEL, not the db. A worker holds no
    // database credentials (the guard rejects direct access), so this must start
    // after the supervisor exists — the first flush reads from byte 0, so no
    // boot output is lost by starting here rather than earlier.
    if (logPath && insideWorker()) {
      try {
        const server = supervisor;
        stopLogFlusher = startWorkerLogFlusher(runId, logPath, {
          sink: async (text) => {
            await server.emit("worker.log", { entries: [{ message: text }] });
          },
        });
      } catch (e) {
        // A log-capture failure must never stop us from driving the run.
        console.error("[run-worker] failed to start log flusher:", e);
      }
    }

    const session = supervisor.session;
    if (!session.waitForStart || !session.commands) {
      throw new Error("worker supervisor session does not expose the ws run-driver API");
    }
    const start = await session.waitForStart();
    await driveWorkerRun({ start, session: session as WorkerDriverSession });
    log.info("worker finished", { runId });
  } catch (e) {
    log.error("worker fatal", { runId, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    exitCode = 1;
  } finally {
    // Terminal flush of runner.log — wraps BOTH the success and the catch path
    // so the last bytes land regardless of how the run ended. Runs BEFORE
    // process.exit (which would otherwise terminate before this awaited flush)
    // and, critically, BEFORE supervisor.close(): the flush emits over the
    // channel, so closing the session first makes the most important flush of
    // the run fail with "worker session is closed" every time.
    if (stopLogFlusher) await stopLogFlusher().catch(() => {});
    await supervisor?.close().catch(() => {});
  }
  process.exit(exitCode);
}

void main();
