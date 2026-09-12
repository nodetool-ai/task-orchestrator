import type { BackendDiagnostics } from "../agent-backend/types";

type WatchdogOptions = {
  abort: AbortController;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  deadline?: string | null;
  onWarning?: (message: string) => void;
  diagnostics?: BackendDiagnostics;
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
  let progressSummaryTimer: NodeJS.Timeout | undefined;
  let settled = false;
  let resetCount = 0;
  let lastResetReason = "initial arm";
  let lastMeaningfulProgressAt = startedAt;
  const configuredDeadline = options.deadline ? Date.parse(options.deadline) : Infinity;
  const effectiveDeadline = Math.min(
    options.hardTimeoutMs > 0 ? startedAt + options.hardTimeoutMs : Infinity,
    Number.isFinite(configuredDeadline) ? configuredDeadline : Infinity,
  );
  const deadlineIso = (fallback: number) => new Date(Math.min(effectiveDeadline, fallback)).toISOString();
  let rejectGuard!: (error: unknown) => void;
  const guard = new Promise<never>((_, reject) => { rejectGuard = reject; });
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    try {
      options.diagnostics?.emit("watchdog.expired", {
        deadline: deadlineIso(lastMeaningfulProgressAt + Math.max(0, options.idleTimeoutMs)),
        actual_firing_time: new Date().toISOString(),
        last_meaningful_progress_time: new Date(lastMeaningfulProgressAt).toISOString(),
        "watchdog.armed": options.idleTimeoutMs > 0,
        "watchdog.disabled": options.idleTimeoutMs <= 0,
        "watchdog.fired": true,
        "watchdog.latest_reset": lastResetReason,
        "watchdog.reset_count": resetCount,
        "watchdog.next_expiry": deadlineIso(lastMeaningfulProgressAt + Math.max(0, options.idleTimeoutMs)),
        ...(options.diagnostics?.snapshot?.() ?? {}),
      });
    } catch { /* diagnostics never affect the watchdog */ }
    // Reject with the useful watchdog reason before SDK abort listeners can
    // replace it with a generic cancellation error.
    rejectGuard(error);
    options.abort.abort(error);
  };
  const progress = (activity: string) => {
    if (settled) return;
    lastActivity = activity.slice(0, 200);
    lastMeaningfulProgressAt = Date.now();
    lastResetReason = "meaningful backend progress";
    resetCount += 1;
    clearTimeout(idleTimer);
    clearTimeout(warningTimer);
    if (!progressSummaryTimer) {
      progressSummaryTimer = setInterval(() => {
        if (settled) return;
        let snapshot: Record<string, unknown> = {};
        try { snapshot = options.diagnostics?.snapshot?.() ?? {}; } catch { /* best effort */ }
        try {
          options.diagnostics?.emit("backend.progress", {
            ...snapshot,
            last_meaningful_progress_time: new Date(lastMeaningfulProgressAt).toISOString(),
            "watchdog.armed": options.idleTimeoutMs > 0,
            "watchdog.disabled": options.idleTimeoutMs <= 0,
            "watchdog.fired": false,
            "watchdog.latest_reset": lastResetReason,
            "watchdog.reset_count": resetCount,
            "watchdog.next_expiry": options.idleTimeoutMs > 0
              ? deadlineIso(lastMeaningfulProgressAt + options.idleTimeoutMs)
              : undefined,
          });
        } catch { /* diagnostics never affect the watchdog */ }
      }, 30_000);
      progressSummaryTimer.unref?.();
    }
    if (options.idleTimeoutMs <= 0) return;
    warningTimer = setTimeout(() => {
      const message = `No backend progress for ${Math.floor(options.idleTimeoutMs / 2)}ms. Last activity: ${lastActivity}. ` +
        `The turn will be interrupted after ${options.idleTimeoutMs}ms without progress.`;
      try {
        options.diagnostics?.emit("watchdog.warning", {
          deadline: deadlineIso(lastMeaningfulProgressAt + options.idleTimeoutMs),
          actual_firing_time: new Date().toISOString(),
          last_meaningful_progress_time: new Date(lastMeaningfulProgressAt).toISOString(),
          "watchdog.armed": true,
          "watchdog.disabled": false,
          "watchdog.fired": false,
          "watchdog.latest_reset": lastResetReason,
          "watchdog.reset_count": resetCount,
          "watchdog.next_expiry": deadlineIso(lastMeaningfulProgressAt + options.idleTimeoutMs),
          ...(options.diagnostics?.snapshot?.() ?? {}),
        });
      } catch { /* diagnostics never affect the watchdog */ }
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
    if (effectiveDeadline <= startedAt) {
      fail(new Error("Agent turn exceeded its explicit wall-clock deadline"));
      return await guard;
    }
    if (Number.isFinite(effectiveDeadline)) {
      hardTimer = setTimeout(() => fail(new Error("Agent turn exceeded its explicit wall-clock deadline")), effectiveDeadline - startedAt);
      hardTimer.unref?.();
    }
    progress(lastActivity);
    // Arming the timers is not backend progress. Preserve the initial state so
    // a stalled adapter's first summary cannot claim an SDK-originated reset.
    lastMeaningfulProgressAt = startedAt;
    lastResetReason = "initial arm";
    resetCount = 0;
    // Promise.resolve also captures a synchronous throw from an adapter.
    running = Promise.resolve().then(() => operation(progress));
    return await Promise.race([running, guard]);
  } finally {
    settled = true;
    clearTimeout(idleTimer);
    clearTimeout(warningTimer);
    clearTimeout(hardTimer);
    clearInterval(progressSummaryTimer);
    options.abort.signal.removeEventListener("abort", onAbort);
    // A slow/ignoring adapter may settle after the watchdog has returned.
    void running?.catch(() => undefined);
  }
}
