// lib/codeact/thread-worker.ts
//
// Dedicated worker-thread entry for a single CodeAct guest execution (plan
// "Runtime decision": "Run guest evaluation in a dedicated Node worker
// thread"). One thread == one execution: it evaluates once, posts the outcome,
// and exits. The host (lib/codeact/thread.ts) owns the thread's lifetime and
// can terminate it externally against a hard deadline — the thread is the
// scheduling and termination boundary; the WASM sandbox and the narrow bridge
// are the isolation boundary.
//
// This file is loaded by a raw Node worker (outside any test/build transform),
// relying on Node's native TypeScript type-stripping — hence the explicit `.ts`
// import specifiers throughout lib/codeact.

import { parentPort, workerData } from "node:worker_threads";
import { evaluateGuest, type EvaluateOutcome } from "./evaluate.ts";
import type { ExecutionLimits } from "./limits.ts";

export interface ThreadWorkerData {
  code: string;
  limits: Partial<ExecutionLimits>;
  /** WASM bytes, resolved by the host and transferred in so the worker never
   *  needs node_modules resolution or filesystem access of its own. */
  wasmBinary: ArrayBuffer;
}

export type ThreadWorkerMessage =
  | { type: "result"; outcome: EvaluateOutcome }
  | { type: "host-error"; error: { name: string; message: string; stack?: string } };

async function main(): Promise<void> {
  const { code, limits, wasmBinary } = workerData as ThreadWorkerData;
  const outcome = await evaluateGuest({ code, limits, wasmBinary });
  const message: ThreadWorkerMessage = { type: "result", outcome };
  parentPort?.postMessage(message);
}

main().catch((err: unknown) => {
  const error =
    err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack }
      : { name: "Error", message: String(err) };
  const message: ThreadWorkerMessage = { type: "host-error", error };
  parentPort?.postMessage(message);
});
