// `^k` jump palette (T-tui-05). Runs, tasks and plans in one list, matched by
// a subsequence fuzzy match — `includes` would miss "t5cli" for
// "T-0005 CLI shares the repo layer", which is exactly how people type here.

import type { PlanSummary, TaskSummary } from "../api/types.js";
import type { Run } from "./run.js";

export interface PaletteItem {
  kind: "run" | "task" | "plan";
  id: string;
  label: string;
  runId?: number;
}

export function buildPalette(runs: Run[], tasks: TaskSummary[], plans: PlanSummary[]): PaletteItem[] {
  return [
    // Runs first: the palette is mostly used to get back to a conversation.
    ...runs.map((r) => ({ kind: "run" as const, id: `#${r.id}`, label: `${r.persona} · ${r.title}`, runId: r.id })),
    ...tasks.map((t) => ({ kind: "task" as const, id: t.id, label: t.title })),
    ...plans.map((p) => ({ kind: "plan" as const, id: p.id, label: p.title })),
  ];
}

export function filterPalette(items: PaletteItem[], query: string, limit = 20): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const scored: Array<{ item: PaletteItem; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const id = score(item.id.toLowerCase(), q);
    const label = score(item.label.toLowerCase(), q);
    // The id is the thing you actually type, so a hit there outranks a hit in
    // the prose title even when the title match is tighter.
    const best = Math.max(id === null ? -Infinity : id + ID_BONUS, label ?? -Infinity);
    if (best > -Infinity) scored.push({ item, score: best, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.item);
}

const ID_BONUS = 60;

/**
 * Subsequence score, higher is better, `null` when `q` is not a subsequence of
 * `s`. Earlier matches and fewer gaps win; a straight prefix wins outright.
 * Every starting position is tried because a greedy walk from the first hit
 * misses the contiguous run later in the string ("cli" in "T-0005 CLI …").
 */
function score(s: string, q: string): number | null {
  if (!q) return 0;
  let best: number | null = null;
  for (let start = 0; start <= s.length - q.length; start++) {
    if (s[start] !== q[0]) continue;
    let qi = 0;
    let gaps = 0;
    let last = -1;
    for (let i = start; i < s.length && qi < q.length; i++) {
      if (s[i] !== q[qi]) continue;
      if (last >= 0 && i !== last + 1) gaps++;
      last = i;
      qi++;
    }
    if (qi < q.length) continue;
    const span = last - start + 1;
    let v = 100 - start * 4 - gaps * 12 - (span - q.length);
    if (start === 0) v += 40; // prefix
    else if (!/[a-z0-9]/.test(s[start - 1])) v += 15; // word boundary
    if (best === null || v > best) best = v;
  }
  return best;
}
