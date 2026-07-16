// __tests__/worker-runtime-bundle-guard.test.ts
//
// Guard test (plan section 13.4). The worker-side ws bundle — the run driver in
// lib/worker-runtime and the transport-side channel modules the worker process
// loads — must never read Postgres or the control-plane HTTP API. This test
// fails if any of those modules contains a control-plane read string or a
// bootstrap-read function call, so a future edit that reintroduces a worker read
// is caught mechanically.
//
// Function-name string checks are deliberately scoped to the worker bundle
// modules so ordinary control-plane source (e.g. snapshot.ts, which legitimately
// calls dbTransport.getTask to BUILD the pushed snapshot) does not trip them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");

// The modules the worker process loads on the websocket transport path:
// the run driver, plus the transport-side channel modules the supervisor uses.
// Control-plane-only channel modules (snapshot/connection/registry/repository/
// controller) are intentionally excluded — they run on the server and may read.
const WORKER_BUNDLE_MODULES = [
  "lib/worker-runtime/context.ts",
  "lib/worker-channel/worker-server.ts",
  "lib/worker-channel/worker-session.ts",
  "lib/worker-channel/spool.ts",
  "lib/worker-channel/codec.ts",
  "lib/worker-channel/credential.ts",
  "lib/worker-channel/protocol.ts",
];

const FORBIDDEN_STRINGS = [
  "/api/worker",
  "TASK_ORCH_WORKER_API_URL",
  "DATABASE_URL",
  "getTask(",
  "getPlan(",
  "getPersona(",
  "resolveRepo(",
  "subscribeInput(",
];

/** Strip line comments and block comments so a forbidden token that appears
 *  only in explanatory prose (like this file's own doc header, or a module's
 *  comments referencing the deleted reads) does not create a false positive. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("worker bundle read guard (plan 13.4)", () => {
  for (const relativePath of WORKER_BUNDLE_MODULES) {
    it(`${relativePath} contains no worker read strings`, () => {
      const source = stripComments(readFileSync(join(REPO_ROOT, relativePath), "utf8"));
      const hits = FORBIDDEN_STRINGS.filter((needle) => source.includes(needle));
      expect(hits, `forbidden read tokens in ${relativePath}: ${hits.join(", ")}`).toEqual([]);
    });
  }
});
