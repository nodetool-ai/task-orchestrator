type WatchdogOptions = {
  abort: AbortController;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  deadline?: string | null;
  onWarning?: (message: string) => void;
};

/** Separate lack of SDK progress from an explicit wall-clock budget. Timers
 * are scoped to the invocation and armed before calling even a stuck backend.
 * This measures turn progress, never provider/process liveness. */
export async function runWithTurnWatchdog<T>(
  options: WatchdogOptions,
  operation: (progress: (activity: string) => void) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let lastActivity = "waiting for backend output";
  let idleTimer: NodeJS.Timeout | undefined;
  let warningTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let settled = false;
  let rejectGuard!: (error: unknown) => void;
  const guard = new Promise<never>((_, reject) => { rejectGuard = reject; });
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    // Reject with the useful watchdog reason before SDK abort listeners can
    // replace it with a generic cancellation error.
    rejectGuard(error);
    options.abort.abort(error);
  };
  const progress = (activity: string) => {
    if (settled) return;
    lastActivity = activity.slice(0, 200);
    clearTimeout(idleTimer);
    clearTimeout(warningTimer);
    if (options.idleTimeoutMs <= 0) return;
    warningTimer = setTimeout(() => {
      const message = `No backend progress for ${Math.floor(options.idleTimeoutMs / 2)}ms. Last activity: ${lastActivity}. ` +
        `The turn will be interrupted after ${options.idleTimeoutMs}ms without progress.`;
      options.onWarning?.(message);
    }, Math.floor(options.idleTimeoutMs / 2));
    warningTimer.unref?.();
    idleTimer = setTimeout(() => fail(new Error(
      `Agent turn stalled: no backend progress for ${options.idleTimeoutMs}ms. ` +
      `Last activity: ${lastActivity}. Turn elapsed: ${Date.now() - startedAt}ms.`,
    )), options.idleTimeoutMs);
    idleTimer.unref?.();
  };
  const onAbort = () => {
    settled = true;
    rejectGuard(options.abort.signal.reason ?? new Error("Agent turn aborted"));
  };
  options.abort.signal.addEventListener("abort", onAbort, { once: true });
  let running: Promise<T> | undefined;
  try {
    if (options.abort.signal.aborted) {
      onAbort();
      return await guard;
    }
    const explicitDeadline = options.deadline ? Date.parse(options.deadline) : Infinity;
    const hardDeadline = Math.min(
      options.hardTimeoutMs > 0 ? startedAt + options.hardTimeoutMs : Infinity,
      Number.isFinite(explicitDeadline) ? explicitDeadline : Infinity,
    );
    if (hardDeadline <= startedAt) {
      fail(new Error("Agent turn exceeded its explicit wall-clock deadline"));
      return await guard;
    }
    if (Number.isFinite(hardDeadline)) {
      hardTimer = setTimeout(() => fail(new Error("Agent turn exceeded its explicit wall-clock deadline")), hardDeadline - startedAt);
      hardTimer.unref?.();
    }
    progress(lastActivity);
    // Promise.resolve also captures a synchronous throw from an adapter.
    running = Promise.resolve().then(() => operation(progress));
    return await Promise.race([running, guard]);
  } finally {
    settled = true;
    clearTimeout(idleTimer);
    clearTimeout(warningTimer);
    clearTimeout(hardTimer);
    options.abort.signal.removeEventListener("abort", onAbort);
    // A slow/ignoring adapter may settle after the watchdog has returned.
    void running?.catch(() => undefined);
  }
}
