// lib/codeact/evaluate.ts
//
// The core CodeAct guest evaluation, shared by the in-process local fixture and
// the dedicated worker thread (lib/codeact/thread-worker.ts). It owns the five
// invariants the plan requires of an execution:
//
//   * fresh runtime/context  — every call builds a brand-new WASM module,
//     runtime, and context; contexts can share a runtime heap, so we never do
//     that (plan "Runtime decision": "use separate runtimes for separate
//     executions"). Nothing — not compiled state, not the heap — is reused.
//   * enforced limits         — memory + stack + an interrupt-callback deadline.
//   * explicit promise pumping — the guest body is an async function; after it
//     starts we drive QuickJS's job queue ourselves until the returned promise
//     settles. Waiting on a guest promise without pumping can deadlock (plan
//     "Promise integration").
//   * deterministic disposal  — every handle/context/runtime is disposed in a
//     finally, in reverse order, on every path including error and timeout.
//
// External (hard, out-of-guest) termination is the worker thread's job, not
// this module's: see lib/codeact/thread.ts.

import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSHandle,
  type QuickJSContext,
} from "quickjs-emscripten-core";
import { newCodeActVariant, loadPackagedWasm, assertWasmMagic } from "./quickjs-variant.ts";
import { resolveLimits, type ExecutionLimits } from "./limits.ts";

export interface EvaluateRequest {
  /** Guest source, interpreted as an async function body (top-level await and
   *  `return` allowed). TypeScript syntax is NOT evaluated in v1. */
  code: string;
  /** Resource limits; unspecified fields fall back to DEFAULT_LIMITS. */
  limits?: Partial<ExecutionLimits>;
  /** Pre-read WASM bytes. When omitted the packaged artifact is loaded from
   *  disk (no network). Passing them lets the caller load once and reuse the
   *  bytes across executions (never guest state — just the immutable bytes). */
  wasmBinary?: ArrayBuffer;
}

export type EvaluateOutcome =
  | { status: "ok"; value: unknown; jobsExecuted: number }
  | { status: "error"; error: GuestError; jobsExecuted: number }
  | { status: "timeout"; jobsExecuted: number };

/** A guest-thrown error, flattened to structured-cloneable primitives so it can
 *  cross the worker boundary. */
export interface GuestError {
  name: string;
  message: string;
  stack?: string;
}

/** True when a QuickJS error dump is the interrupt-callback unwinding a runaway
 *  guest (deadline hit) rather than an ordinary thrown error. */
function isInterrupt(dump: unknown): boolean {
  return (
    typeof dump === "object" &&
    dump !== null &&
    (dump as { message?: unknown }).message === "interrupted"
  );
}

function toGuestError(ctx: QuickJSContext, handle: QuickJSHandle): GuestError {
  const dumped = ctx.dump(handle) as Record<string, unknown> | string | undefined;
  if (dumped && typeof dumped === "object") {
    return {
      name: typeof dumped.name === "string" ? dumped.name : "Error",
      message: typeof dumped.message === "string" ? dumped.message : String(dumped),
      stack: typeof dumped.stack === "string" ? dumped.stack : undefined,
    };
  }
  return { name: "Error", message: String(dumped) };
}

/**
 * Evaluate `code` in a fresh, disposable QuickJS-NG sandbox and return a
 * structured-cloneable outcome. Never throws for guest-level failures (they
 * become `status: "error"` / `"timeout"`); only genuinely exceptional host
 * conditions (e.g. the WASM failing to instantiate) propagate.
 */
export async function evaluateGuest(req: EvaluateRequest): Promise<EvaluateOutcome> {
  const limits = resolveLimits(req.limits);
  const wasmBinary = req.wasmBinary ?? (await loadPackagedWasm());
  assertWasmMagic(wasmBinary);

  // Fresh module → runtime → context for THIS execution only.
  const mod = await newQuickJSWASMModuleFromVariant(newCodeActVariant(wasmBinary));
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);

  const guestDeadline = Date.now() + limits.guestDeadlineMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(guestDeadline));

  const context = runtime.newContext();
  let jobsExecuted = 0;

  try {
    // Wrap the guest source as an immediately-invoked async function so top-level
    // `await`/`return` work and the result is always a promise we can pump.
    const wrapped = `(async () => {\n${req.code}\n})()`;
    const evalResult = context.evalCode(wrapped, "codeact.js");

    if (evalResult.error) {
      const dump = context.dump(evalResult.error);
      evalResult.error.dispose();
      if (isInterrupt(dump)) return { status: "timeout", jobsExecuted };
      return { status: "error", error: normalizeDump(dump), jobsExecuted };
    }

    const promise = evalResult.value;
    try {
      // Explicit promise-job pump: drive the queue until the returned promise
      // settles, the deadline passes, or the queue drains with nothing settling
      // (which, absent host async, means it can never settle — bail rather than
      // spin). The interrupt handler independently unwinds a busy loop inside a
      // single job.
      let state = context.getPromiseState(promise);
      while (state.type === "pending") {
        if (Date.now() > guestDeadline) return { status: "timeout", jobsExecuted };

        const pumped = runtime.executePendingJobs();
        if (pumped.error) {
          const dump = context.dump(pumped.error);
          pumped.error.dispose();
          if (isInterrupt(dump)) return { status: "timeout", jobsExecuted };
          return { status: "error", error: normalizeDump(dump), jobsExecuted };
        }
        jobsExecuted += pumped.value;
        state = context.getPromiseState(promise);
        // Queue drained and still pending → nothing left to make it settle.
        if (state.type === "pending" && pumped.value === 0) {
          return {
            status: "error",
            error: {
              name: "CodeActDeadlock",
              message:
                "guest promise never settled and no pending jobs remain (missing host async?)",
            },
            jobsExecuted,
          };
        }
      }

      if (state.type === "fulfilled") {
        const value = context.dump(state.value);
        state.value.dispose();
        return { status: "ok", value, jobsExecuted };
      }
      // rejected
      const error = toGuestError(context, state.error);
      state.error.dispose();
      return { status: "error", error, jobsExecuted };
    } finally {
      promise.dispose();
    }
  } finally {
    // Deterministic disposal, reverse order, on every path.
    context.dispose();
    runtime.dispose();
  }
}

function normalizeDump(dump: unknown): GuestError {
  if (dump && typeof dump === "object") {
    const d = dump as Record<string, unknown>;
    return {
      name: typeof d.name === "string" ? d.name : "Error",
      message: typeof d.message === "string" ? d.message : JSON.stringify(dump),
      stack: typeof d.stack === "string" ? d.stack : undefined,
    };
  }
  return { name: "Error", message: String(dump) };
}
