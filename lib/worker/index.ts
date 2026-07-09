// lib/worker/index.ts
//
// Transport selection for the worker ⇄ orchestrator protocol.
//
//   • Web-server / CLI / tests: always the db transport (they ARE the
//     orchestrator; the HTTP API is a loopback there, not a simplification).
//   • Worker process (TASK_ORCH_INSIDE_WORKER=1): the http transport,
//     REQUIRED. Workers speak HTTP + SSE against /api/worker and hold no
//     database access at all — dispatch injects TASK_ORCH_WORKER_API_URL +
//     TASK_ORCH_WORKER_TOKEN and withholds DATABASE_URL. A worker booted
//     without those fails fast here rather than limping along on Postgres.
//     (TASK_ORCH_WORKER_ALLOW_DB=1 is a test-only escape hatch for suites
//     that simulate a worker's env inside the orchestrator process; it is
//     unsupported for real deployments.)
//
// The implementations are loaded lazily so that importing lib/runs.ts (which
// calls runTransport() in many code paths) never forms an import cycle, and so
// an http-mode worker doesn't touch the db module at selection time.

import { config } from "../config";
import { createLogger } from "./log";
import type { RunTransport } from "./protocol";

export type { RunTransport } from "./protocol";
export * from "./protocol";

const log = createLogger("worker-transport");

function insideWorkerProcess(): boolean {
  return config.worker.inside;
}

/** True when this process should (and can) speak the worker HTTP protocol. */
export function httpTransportConfigured(): boolean {
  return insideWorkerProcess() && !!config.worker.apiUrl && !!config.worker.apiToken;
}

/** Test-only escape hatch (see the module docstring). */
function dbAllowedInWorker(): boolean {
  return config.worker.allowDb;
}

let cached: Promise<RunTransport> | null = null;

/**
 * The process-wide RunTransport. Memoized after the first call; the selection
 * inputs are boot env vars, so they cannot change mid-process.
 *
 * HARD REQUIREMENT: a worker process without HTTP credentials throws here
 * (synchronously, un-memoized) — workers must not fall back to Postgres.
 */
export function runTransport(): Promise<RunTransport> {
  if (!cached) {
    if (insideWorkerProcess() && !httpTransportConfigured() && !dbAllowedInWorker()) {
      throw new Error(
        "This process is a run worker (TASK_ORCH_INSIDE_WORKER=1) without worker " +
          "API credentials. Workers speak the HTTP protocol only — dispatch must " +
          "inject TASK_ORCH_WORKER_API_URL + TASK_ORCH_WORKER_TOKEN (set " +
          "TASK_ORCH_WORKER_API_URL, or NEXTAUTH_URL as a fallback, on the " +
          "server). Direct-Postgres workers are no longer supported. See " +
          "docs/worker-http-api.md."
      );
    }
    cached = (async () => {
      if (httpTransportConfigured()) {
        const { createHttpTransport } = await import("./http-transport");
        const t = createHttpTransport({
          baseUrl: config.worker.apiUrl!,
          token: config.worker.apiToken!,
        });
        log.info("worker transport selected", { kind: "http", baseUrl: config.worker.apiUrl });
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
