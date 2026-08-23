// Formatting helpers. `now` is always a parameter: the same frame rendered at
// two different clock times must be a pure function of its inputs, or the
// snapshot tests turn into a stopwatch.

export function ageMinutes(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / 60_000));
}

/** "now" | "12m" | "3h" | "2d" — thresholds copied from tui/src/theme.tsx. */
export function age(at: number, now: number): string {
  const min = ageMinutes(at, now);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

/** "12s" | "1m 3s" | "1h 4m" — the live line's timer, which counts a turn
 *  rather than dating a run, so it never rounds a minute away. Copied from
 *  Claude Code's spinner (utils/format.ts formatDuration). */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}m ${total % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
