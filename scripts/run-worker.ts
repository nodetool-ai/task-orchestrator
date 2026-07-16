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

import { config as appConfig } from "../lib/config";
import { driveDispatchedRun } from "../lib/runs";
import { driveWorkerRun, type WorkerDriverSession } from "../lib/worker-runtime/context";
import { insideWorker } from "../lib/runner/provider";
import { startWorkerLogFlusher } from "../lib/runner/worker-log-store";
import { installProcessSafetyNet } from "../lib/transient-errors";
import { httpTransportConfigured, websocketTransportConfigured } from "../lib/worker";
import { startWorkerServer, type WorkerServer } from "../lib/worker-channel/worker-server";
import { ProtocolMismatchError } from "../lib/worker/http-transport";
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

  log.info("worker starting", {
    runId,
    transport: websocketTransportConfigured() ? "ws" : httpTransportConfigured() ? "http" : "db",
    pid: process.pid,
  });

  // Ship the worker's runner.log off the ephemeral Fly volume into Postgres so
  // its debugging history survives the Machine + volume being destroyed. The
  // Fly entrypoint tee's all worker stdout/stderr to $SESSION_ROOT/logs/runner.log;
  // only start the flusher inside a worker (insideWorker(), which correctly
  // treats "0"/"false" as off) with a SESSION_ROOT set — i.e. the case where
  // that tee file actually exists.
  const sessionRoot = process.env.SESSION_ROOT;
  const logPath = sessionRoot ? `${sessionRoot}/logs/runner.log` : null;
  let stopLogFlusher: (() => Promise<void>) | null = null;
  if (logPath && insideWorker()) {
    try {
      stopLogFlusher = startWorkerLogFlusher(runId, logPath);
    } catch (e) {
      // A log-capture failure must never stop us from driving the run.
      console.error("[run-worker] failed to start log flusher:", e);
    }
  }

  let exitCode = 0;
  let supervisor: WorkerServer | undefined;
  try {
    if (websocketTransportConfigured()) {
      // WebSocket transport (plan section 13): the control plane pushes the
      // authoritative RunStart snapshot and all subsequent input over the
      // channel. Start the supervisor, wait for that snapshot, build the
      // worker run context from it, and drive the run without any Postgres or
      // control-plane HTTP read. The supervisor is closed (drained) in the
      // finally below.
      supervisor = await startWorkerServer({
        runId,
        instanceId: appConfig.worker.channelInstanceId!,
        credential: appConfig.worker.channelCredential!,
        endpoint: appConfig.worker.channelEndpoint!,
      });
      const session = supervisor.session;
      if (!session.waitForStart || !session.commands) {
        throw new Error("worker supervisor session does not expose the ws run-driver API");
      }
      const start = await session.waitForStart();
      await driveWorkerRun({ start, session: session as WorkerDriverSession });
    } else {
      await driveDispatchedRun(runId);
    }
    log.info("worker finished", { runId });
  } catch (e) {
    if (e instanceof ProtocolMismatchError) {
      // The server redeployed with an incompatible worker protocol. Exiting
      // nonzero kills this Machine; the stale-lease reaper then re-dispatches
      // the run onto a fresh worker built from the new image — the system
      // already handles this exactly like any other worker death.
      log.error("worker protocol mismatch — exiting for reaper re-dispatch", {
        runId,
        server: e.serverVersion,
        client: e.clientVersion,
      });
    } else {
      log.error("worker fatal", { runId, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    }
    exitCode = 1;
  } finally {
    await supervisor?.close().catch(() => {});
    // Terminal flush of runner.log — wraps BOTH the success and the catch path
    // so the last bytes land regardless of how the run ended. Runs BEFORE
    // process.exit (which would otherwise terminate before this awaited flush).
    if (stopLogFlusher) await stopLogFlusher().catch(() => {});
  }
  process.exit(exitCode);
}

void main();
