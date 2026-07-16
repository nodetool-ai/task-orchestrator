// lib/worker/index.ts
//
// RunTransport selection for control-plane code.
//
// The worker ⇄ orchestrator protocol is WebSocket-only (plan section 18): a
// dispatched worker process runs `driveWorkerRun` against its private channel
// and never constructs a RunTransport. The db transport that remains here is the
// control plane's own loopback implementation — the web server, CLI, and tests
// ARE the orchestrator, so they read/write run state directly through it.
//
// The implementation is loaded lazily so that importing lib/runs.ts (which calls
// runTransport() in many code paths) never forms an import cycle.

import type { RunTransport } from "./protocol";

export type { RunTransport } from "./protocol";
export * from "./protocol";

let cached: Promise<RunTransport> | null = null;

/**
 * The process-wide RunTransport: always the control-plane db transport. Memoized
 * after the first call.
 */
export function runTransport(): Promise<RunTransport> {
  if (!cached) {
    cached = (async () => {
      const { dbTransport } = await import("./db-transport");
      return dbTransport;
    })();
  }
  return cached;
}

/** Test hook: clear the memoized transport. */
export function __resetRunTransportForTests(): void {
  cached = null;
}
