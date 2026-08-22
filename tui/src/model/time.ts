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

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
