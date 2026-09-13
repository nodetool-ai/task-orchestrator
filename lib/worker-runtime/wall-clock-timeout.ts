/** Node's timer clock can pause while a VM hibernates. Poll only the remaining
 * Date.now deadline, so expiry catches up within one second after execution
 * resumes. This local check produces no progress or transport heartbeat. */
export function wallClockTimeout(callback: () => void, delayMs: number): () => void {
  const deadline = Date.now() + delayMs;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      cancelled = true;
      callback();
      return;
    }
    timer = setTimeout(tick, Math.min(1_000, remaining));
    timer.unref?.();
  };
  tick();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
