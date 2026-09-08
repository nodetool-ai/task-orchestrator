// lib/codeact/limits.ts
//
// Resource limits enforced on a single CodeAct guest execution. These are the
// knobs QuickJS exposes (plan "Runtime decision": "QuickJS provides runtime
// memory limits, stack limits, and an interrupt callback"), plus the host-side
// hard wall-clock ceiling the worker thread is terminated against.

export interface ExecutionLimits {
  /** Runtime heap ceiling in bytes (QuickJSRuntime.setMemoryLimit). */
  memoryBytes: number;
  /** Guest stack ceiling in bytes (QuickJSRuntime.setMaxStackSize). */
  stackBytes: number;
  /**
   * Soft in-guest deadline in milliseconds. Enforced by the interrupt
   * callback (shouldInterruptAfterDeadline): a runaway *JavaScript* loop is
   * unwound with an "interrupted" InternalError. Cannot interrupt a wedged
   * native/WASM call — that is what the hard wall-clock ceiling is for.
   */
  guestDeadlineMs: number;
  /**
   * Hard wall-clock ceiling in milliseconds, enforced OUTSIDE the guest by the
   * host: if the worker thread has not reported a result by then it is
   * terminated (Worker.terminate). Must exceed guestDeadlineMs so the softer,
   * cleaner interrupt gets first refusal; the hard kill is the backstop for a
   * hang the interrupt cannot reach.
   */
  hardDeadlineMs: number;
}

/** Conservative defaults for a v1 prototype execution. */
export const DEFAULT_LIMITS: ExecutionLimits = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  guestDeadlineMs: 1000,
  hardDeadlineMs: 2000,
};

/** Fill any unspecified limit from {@link DEFAULT_LIMITS}. */
export function resolveLimits(partial?: Partial<ExecutionLimits>): ExecutionLimits {
  return { ...DEFAULT_LIMITS, ...(partial ?? {}) };
}
