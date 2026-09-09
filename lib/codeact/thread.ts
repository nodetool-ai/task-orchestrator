// lib/codeact/thread.ts
//
// Host side of the dedicated-thread CodeAct prototype. Spawns one worker thread
// per execution, hands it the guest source + limits + pre-read WASM bytes, and
// enforces the HARD, out-of-guest deadline: if the worker has not reported an
// outcome by `hardDeadlineMs`, the host terminates the thread
// (Worker.terminate) and returns a `terminated` result. This is the backstop
// the in-guest interrupt callback cannot provide — it kills a thread wedged in
// a native/WASM call or otherwise unresponsive to the interrupt.
//
// Keeping guest computation on its own thread also keeps it off the
// channel/control-plane event loop (plan "Runtime decision").

import { Worker } from "node:worker_threads";
import { loadPackagedWasm } from "./quickjs-variant.ts";
import { resolveLimits, type ExecutionLimits } from "./limits.ts";
import type { EvaluateOutcome } from "./evaluate.ts";
import type { ThreadWorkerData, ThreadWorkerMessage } from "./thread-worker.ts";
import type { GuestOutput, GuestDiagnostic } from "./evaluate.ts";

/** URL of the worker entry, resolved relative to this module so it works from a
 *  source checkout (Node strips the .ts) and from tests alike. */
const WORKER_URL = new URL("./thread-worker.ts", import.meta.url);

export type ThreadResult =
  | { status: "ok"; value: unknown; jobsExecuted: number; outputs?: GuestOutput[]; diagnostics?: GuestDiagnostic[] }
  | { status: "error"; error: { name: string; message: string; stack?: string }; jobsExecuted: number; outputs?: GuestOutput[]; diagnostics?: GuestDiagnostic[] }
  | { status: "timeout"; jobsExecuted: number; outputs?: GuestOutput[]; diagnostics?: GuestDiagnostic[] }
  | { status: "terminated"; reason: string };

export interface ExecuteInThreadOptions {
  code: string;
  limits?: Partial<ExecutionLimits>;
  /** Pre-read WASM bytes to reuse across executions. Omit to load the packaged
   *  artifact from disk (no network). */
  wasmBinary?: ArrayBuffer;
  catalog?: unknown;
  hostCall?: (operation: string, input: unknown) => Promise<unknown>;
  signal?: AbortSignal;
}

/**
 * Run one CodeAct execution in its own worker thread with an externally
 * enforced hard deadline. Always resolves (never rejects) with a
 * structured-cloneable {@link ThreadResult}.
 */
export async function executeInThread(opts: ExecuteInThreadOptions): Promise<ThreadResult> {
  const limits = resolveLimits(opts.limits);
  const wasmBinary = opts.wasmBinary ?? (await loadPackagedWasm());

  const workerData: ThreadWorkerData = { code: opts.code, limits, wasmBinary, catalog: opts.catalog };
  const worker = new Worker(WORKER_URL, { workerData });

  return await new Promise<ThreadResult>((resolve) => {
    let settled = false;
    const finish = (result: ThreadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Terminate unconditionally: on the happy path this reaps the one-shot
      // thread; on the timeout path it is the external kill itself.
      void worker.terminate();
      resolve(result);
    };

    const hardTimer = setTimeout(() => {
      finish({
        status: "terminated",
        reason: `hard deadline of ${limits.hardDeadlineMs}ms exceeded; worker thread terminated`,
      });
    }, limits.hardDeadlineMs);
    // Don't let the deadline timer keep the event loop alive on its own.
    hardTimer.unref?.();
    const onAbort = () => finish({ status: "terminated", reason: "execution cancelled; worker thread terminated" });
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (msg: ThreadWorkerMessage) => {
      if (msg.type === "host-call") {
        const reply = (frame: object) => { if (!settled) { try { worker.postMessage(frame); } catch { /* late callback after termination */ } } };
        void (opts.hostCall ? opts.hostCall(msg.operation, msg.input) : Promise.reject(new Error("host RPC unavailable")))
          .then((value) => reply({ type: "host-result", id: msg.id, ok: true, value }))
          .catch((error) => reply({ type: "host-result", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
      } else if (msg.type === "result") {
        finish(toThreadResult(msg.outcome));
      } else {
        finish({ status: "error", error: msg.error, jobsExecuted: 0 });
      }
    });

    worker.on("error", (err) => {
      finish({
        status: "error",
        error: { name: err.name, message: err.message, stack: err.stack },
        jobsExecuted: 0,
      });
    });

    worker.on("exit", (code) => {
      // A non-zero exit before any message is a crash we must not hang on. If
      // we already terminated (timeout / happy path), `settled` swallows this.
      if (code !== 0) {
        finish({ status: "terminated", reason: `worker exited with code ${code}` });
      }
    });
  });
}

function toThreadResult(outcome: EvaluateOutcome): ThreadResult {
  return outcome;
}
