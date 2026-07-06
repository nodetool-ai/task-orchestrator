// lib/worker/index.ts
//
// Transport selection for the worker ⇄ orchestrator protocol.
//
//   • Web-server / CLI / tests: always the db transport (they ARE the
//     orchestrator; the HTTP API is a loopback there, not a simplification).
//   • Worker process (TASK_ORCH_INSIDE_WORKER=1) WITH
//     TASK_ORCH_WORKER_API_URL + TASK_ORCH_WORKER_TOKEN: the http transport —
//     the worker talks to the orchestrator over HTTP + SSE and needs no
//     DATABASE_URL.
//   • Worker process without those: the db transport (legacy direct-Postgres
//     workers keep working unchanged).
//
// The implementations are loaded lazily so that importing lib/runs.ts (which
// calls runTransport() in many code paths) never forms an import cycle, and so
// an http-mode worker doesn't touch the db module at selection time.

import { createLogger } from "./log";
import type { RunTransport } from "./protocol";

export type { RunTransport } from "./protocol";
export * from "./protocol";

const log = createLogger("worker-transport");

function insideWorkerProcess(): boolean {
  const v = process.env.TASK_ORCH_INSIDE_WORKER;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

/** True when this process should (and can) speak the worker HTTP protocol. */
export function httpTransportConfigured(): boolean {
  return (
    insideWorkerProcess() &&
    !!process.env.TASK_ORCH_WORKER_API_URL &&
    !!process.env.TASK_ORCH_WORKER_TOKEN
  );
}

let cached: Promise<RunTransport> | null = null;

/**
 * The process-wide RunTransport. Memoized after the first call; the selection
 * inputs are boot env vars, so they cannot change mid-process.
 */
export function runTransport(): Promise<RunTransport> {
  if (!cached) {
    cached = (async () => {
      if (httpTransportConfigured()) {
        const { createHttpTransport } = await import("./http-transport");
        const t = createHttpTransport({
          baseUrl: process.env.TASK_ORCH_WORKER_API_URL!,
          token: process.env.TASK_ORCH_WORKER_TOKEN!,
        });
        log.info("worker transport selected", { kind: "http", baseUrl: process.env.TASK_ORCH_WORKER_API_URL });
        return t;
      }
      const { dbTransport } = await import("./db-transport");
      if (insideWorkerProcess()) log.debug("worker transport selected", { kind: "db" });
      return dbTransport;
    })();
  }
  return cached;
}

/** Test hook: clear the memoized transport (env-driven selection re-runs). */
export function __resetRunTransportForTests(): void {
  cached = null;
}
