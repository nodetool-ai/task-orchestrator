// Small formatting helpers ported from the prototype (factory-core / mobile-core).

export function fmtTok(n: number): string {
  if (n > 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n > 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function money(n: number | null | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`;
}

/** Compact elapsed since `startMs` → "7m 3s" / "1h 14m" / "12s". */
export function elapsed(startMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const h = Math.floor(diff / 3600);
  const mn = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h) return `${h}h ${mn}m`;
  if (mn) return `${mn}m ${s}s`;
  return `${s}s`;
}

/** hh:mm:ss elapsed used on the run-detail spend tile. */
export function elapsedHms(startMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const h = Math.floor(diff / 3600);
  const mn = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${pad2(h)}:${pad2(mn)}:${pad2(s)}`;
}

/** Short run id (R-YYYYMMDD-NNN), matching the server's shortRunId(). */
export function shortRunId(id: number, startedAtMs: number): string {
  const d = new Date(startedAtMs);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `R-${y}${m}${dd}-${pad2(id)}`;
}

/** Pull a PR number out of a github PR url. */
export function prNumber(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Deterministic gentle sparkline from a seed (server uses the same idea). */
export function fauxSparkline(seed: number): number[] {
  const pts: number[] = [];
  let v = 10 + (seed % 17);
  for (let i = 0; i < 20; i++) {
    v += ((seed * (i + 1)) % 9) - 3;
    pts.push(Math.max(1, v));
  }
  return pts;
}
