// lib/codeact/limits.ts
//
// Resource limits enforced on a single CodeAct guest execution. These are the
// knobs QuickJS exposes (plan "Runtime decision": "QuickJS provides runtime
// memory limits, stack limits, and an interrupt callback"), plus the host-side
// hard wall-clock ceiling the worker thread is terminated against.

export interface ExecutionLimits {
  /** Maximum guest source size in UTF-8 bytes. */
  sourceBytes: number;
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
  /** Maximum host operations and simultaneous host operations. */
  maxOperations: number;
  maxConcurrentOperations: number;
  /** Maximum bytes retained in model-visible output and diagnostics. */
  maxOutputBytes: number;
}

/** Conservative defaults for a v1 prototype execution. */
export const DEFAULT_LIMITS: ExecutionLimits = {
  sourceBytes: 64 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  guestDeadlineMs: 5_000,
  hardDeadlineMs: 60_000,
  maxOperations: 100,
  maxConcurrentOperations: 8,
  maxOutputBytes: 64 * 1024,
};

/** Fill any unspecified limit from {@link DEFAULT_LIMITS}. */
export function resolveLimits(partial?: Partial<ExecutionLimits>): ExecutionLimits {
  const limits = { ...DEFAULT_LIMITS, ...(partial ?? {}) };
  if (!Number.isSafeInteger(limits.sourceBytes) || limits.sourceBytes <= 0) throw new RangeError("sourceBytes must be positive");
  if (!Number.isSafeInteger(limits.maxOperations) || limits.maxOperations <= 0) throw new RangeError("maxOperations must be positive");
  if (!Number.isSafeInteger(limits.maxConcurrentOperations) || limits.maxConcurrentOperations <= 0) throw new RangeError("maxConcurrentOperations must be positive");
  if (limits.maxConcurrentOperations > limits.maxOperations) limits.maxConcurrentOperations = limits.maxOperations;
  if (!Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes <= 0) throw new RangeError("maxOutputBytes must be positive");
  return limits;
}
