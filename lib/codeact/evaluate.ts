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

export interface GuestBridge {
  call(operation: string, input: unknown): Promise<unknown>;
  onOutput?(kind: "text" | "image", value: unknown): void;
  onConsole?(level: string, values: unknown[]): void;
  catalog?: unknown;
}

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
  bridge?: GuestBridge;
}

export type EvaluateOutcome =
  | { status: "ok"; value: unknown; jobsExecuted: number; outputs?: GuestOutput[]; diagnostics?: GuestDiagnostic[] }
  | { status: "error"; error: GuestError; jobsExecuted: number; outputs?: GuestOutput[]; diagnostics?: GuestDiagnostic[] }
  | { status: "timeout"; jobsExecuted: number; outputs?: GuestOutput[]; diagnostics?: GuestDiagnostic[] };

export interface GuestOutput { kind: "text" | "image"; value: unknown }
export interface GuestDiagnostic { level: string; values: unknown[] }

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
  if (new TextEncoder().encode(req.code).byteLength > limits.sourceBytes) {
    return { status: "error", error: { name: "CodeActSourceTooLarge", message: `source exceeds ${limits.sourceBytes} bytes` }, jobsExecuted: 0 };
  }
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
  const outputs: GuestOutput[] = [];
  const diagnostics: GuestDiagnostic[] = [];
  if (req.bridge) installBridge(context, req.bridge, limits, outputs, diagnostics);

  try {
    // Wrap the guest source as an immediately-invoked async function so top-level
    // `await`/`return` work and the result is always a promise we can pump.
    const wrapped = `(async () => {\n${req.code}\n})()`;
    const evalResult = context.evalCode(wrapped, "codeact.js");

    if (evalResult.error) {
      const dump = context.dump(evalResult.error);
      evalResult.error.dispose();
      if (isInterrupt(dump)) return { status: "timeout", jobsExecuted, outputs, diagnostics };
      return { status: "error", error: normalizeDump(dump), jobsExecuted, outputs, diagnostics };
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
        if (Date.now() > guestDeadline) return { status: "timeout", jobsExecuted, outputs, diagnostics };

        const pumped = runtime.executePendingJobs();
        if (pumped.error) {
          const dump = context.dump(pumped.error);
          pumped.error.dispose();
          if (isInterrupt(dump)) return { status: "timeout", jobsExecuted, outputs, diagnostics };
          return { status: "error", error: normalizeDump(dump), jobsExecuted, outputs, diagnostics };
        }
        jobsExecuted += pumped.value;
        state = context.getPromiseState(promise);
        // Let worker-thread message handlers deliver host RPC completions.
        if (state.type === "pending") await new Promise<void>((resolve) => setImmediate(resolve));
        // Queue drained and still pending → nothing left to make it settle.
        if (state.type === "pending" && pumped.value === 0 && !req.bridge) {
          return {
            status: "error",
            error: {
              name: "CodeActDeadlock",
              message:
                "guest promise never settled and no pending jobs remain (missing host async?)",
            },
            jobsExecuted, outputs, diagnostics,
          };
        }
      }

      if (state.type === "fulfilled") {
        const value = context.dump(state.value);
        state.value.dispose();
        return { status: "ok", value, jobsExecuted, outputs, diagnostics };
      }
      // rejected
      const error = toGuestError(context, state.error);
      state.error.dispose();
      return { status: "error", error, jobsExecuted, outputs, diagnostics };
    } finally {
      promise.dispose();
    }
  } finally {
    // Deterministic disposal, reverse order, on every path.
    context.dispose();
    runtime.dispose();
  }
}

function installBridge(
  ctx: QuickJSContext,
  bridge: GuestBridge,
  limits: ExecutionLimits,
  outputs: GuestOutput[],
  diagnostics: GuestDiagnostic[],
): void {
  let operations = 0;
  let inFlight = 0;
  let visibleBytes = 0;
  const queue: Array<() => void> = [];
  const dispatch = (operation: string, input: unknown) => new Promise<unknown>((resolve, reject) => {
    const run = () => {
      inFlight += 1;
      void bridge.call(operation, input).then(resolve, reject).finally(() => {
        inFlight -= 1;
        queue.shift()?.();
      });
    };
    operations += 1;
    if (operations > limits.maxOperations) reject(new Error("CodeAct operation limit exceeded"));
    else if (inFlight < limits.maxConcurrentOperations) run();
    else queue.push(run);
  });
  const call = ctx.newFunction("__codeact_call", (operation, input) => {
    const op = ctx.dump(operation);
    if (typeof op !== "string") return ctx.newError("operation must be a string");
    const deferred = ctx.newPromise();
    void dispatch(op, ctx.dump(input)).then((value) => {
      const handle = ctx.newString(JSON.stringify(value ?? null));
      deferred.resolve(handle); handle.dispose();
    }, (error) => deferred.reject(ctx.newError({ name: "CodeActHostError", message: error instanceof Error ? error.message : String(error) })));
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "__codeact_call", call); call.dispose();
  const bootstrap = `(function(){
    const call = (name, input) => __codeact_call(name, input).then(JSON.parse);
    const make = (prefix) => new Proxy(function(){}, { get: (_, key) => make(prefix + '.' + String(key)), apply: (_, __, args) => call(prefix, args[0] ?? {}) });
    globalThis.app = make('app'); globalThis.tools = make('tools');
    const entries = ${JSON.stringify(bridge.catalog ?? [])};
    globalThis.catalog = { search: ({query=''}={}) => Promise.resolve(entries.filter(x => JSON.stringify(x).toLowerCase().includes(String(query).toLowerCase())).slice(0, 20)), describe: ({names=[]}={}) => Promise.resolve(entries.filter(x => names.includes(x.name) || names.includes(x.sdkPath)).slice(0, 20)) };
    globalThis.output = { text: value => { __codeact_output('text', value); return value; }, image: value => { __codeact_output('image', value); return value; } };
  })()`;
  const result = ctx.evalCode(bootstrap, "codeact-bridge.js");
  if (result.error) result.error.dispose(); else result.value.dispose();
  const output = ctx.newFunction("__codeact_output", (kind, value) => {
    const k = ctx.dump(kind); const v = ctx.dump(value);
    const size = new TextEncoder().encode(JSON.stringify(v ?? null)).byteLength;
    if ((k === "text" || k === "image") && outputs.length < 100 && visibleBytes + size <= limits.maxOutputBytes) { outputs.push({ kind: k, value: v }); visibleBytes += size; bridge.onOutput?.(k, v); }
    return ctx.undefined;
  });
  ctx.setProp(ctx.global, "__codeact_output", output); output.dispose();
  const consoleObject = ctx.newObject();
  for (const level of ["log", "info", "warn", "error"] as const) {
    const fn = ctx.newFunction(level, (...args) => { const values = args.map((arg) => ctx.dump(arg)); const size = new TextEncoder().encode(JSON.stringify(values)).byteLength; if (diagnostics.length < 100 && visibleBytes + size <= limits.maxOutputBytes) { diagnostics.push({ level, values }); visibleBytes += size; bridge.onConsole?.(level, values); } return ctx.undefined; });
    ctx.setProp(consoleObject, level, fn); fn.dispose();
  }
  ctx.setProp(ctx.global, "console", consoleObject); consoleObject.dispose();
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
