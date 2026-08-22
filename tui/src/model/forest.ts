// The run forest: one immutable snapshot of the overview, indexed so the floor
// can re-render on every SSE tick without re-scanning the row list per row.

import type { RunIndexRow } from "../api/types.js";
import { toRun, type Run } from "./run.js";
import { isLive } from "./status.js";

export interface Forest {
  runs: Run[];
  byId(id: number): Run | undefined;
  childrenOf(id: number): Run[];
  roots(): Run[];
  subtreeCost(id: number): number;
  subtreeOf(id: number): Run[];
  /** Nearest parent first — the header breadcrumb reads outwards. */
  ancestors(id: number): Run[];
  liveCount(): number;
}

const NONE: Run[] = [];

export function buildForest(rows: RunIndexRow[]): Forest {
  const runs = rows.map(toRun);
  const byId = new Map<number, Run>();
  for (const r of runs) byId.set(r.id, r);

  // Effective parent, not the raw one: a parent outside this snapshot (paged
  // out, or filtered by the server) would otherwise make its children vanish,
  // so they are promoted to roots instead.
  const parent = new Map<number, number | null>();
  for (const r of runs) {
    const p = r.parentId;
    parent.set(r.id, p !== null && p !== r.id && byId.has(p) ? p : null);
  }
  // A malformed chain (#1→#2→#1) has no root at all; cut it at the node the
  // walk re-enters so every chain terminates and no run is dropped.
  for (const r of runs) {
    const seen = new Set<number>([r.id]);
    let cur = parent.get(r.id) ?? null;
    while (cur !== null) {
      if (seen.has(cur)) {
        parent.set(cur, null);
        break;
      }
      seen.add(cur);
      cur = parent.get(cur) ?? null;
    }
  }

  const children = new Map<number, Run[]>();
  const roots: Run[] = [];
  for (const r of runs) {
    const p = parent.get(r.id) ?? null;
    if (p === null) {
      roots.push(r);
      continue;
    }
    const list = children.get(p);
    if (list) list.push(r);
    else children.set(p, [r]);
  }

  const costs = new Map<number, number>();
  const subtreeCost = (id: number): number => {
    const memo = costs.get(id);
    if (memo !== undefined) return memo;
    let total = 0;
    for (const r of walk(id)) total += r.cost;
    costs.set(id, total);
    return total;
  };

  // Preorder walk of a subtree, defensive about cycles even though the parent
  // map above is already acyclic.
  function walk(id: number): Run[] {
    const out: Run[] = [];
    const seen = new Set<number>();
    const push = (r: Run) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      out.push(r);
      for (const c of children.get(r.id) ?? NONE) push(c);
    };
    const start = byId.get(id);
    if (start) push(start);
    return out;
  }

  return {
    runs,
    byId: (id) => byId.get(id),
    childrenOf: (id) => children.get(id) ?? NONE,
    roots: () => roots,
    subtreeCost,
    subtreeOf: walk,
    ancestors: (id) => {
      const out: Run[] = [];
      const seen = new Set<number>([id]);
      let cur = parent.get(id) ?? null;
      while (cur !== null && !seen.has(cur)) {
        seen.add(cur);
        const r = byId.get(cur);
        if (!r) break;
        out.push(r);
        cur = parent.get(cur) ?? null;
      }
      return out;
    },
    liveCount: () => runs.filter((r) => r.status === "running" || r.status === "preparing").length,
  };
}

export interface TreeRow {
  run: Run;
  prefix: string;
  depth: number;
}

/** Flatten the whole forest. The filter selects ROOTS (a matching root brings
 *  its whole subtree), which is what keeps subtrees intact in floorGroups. */
export function flatten(f: Forest, filter: (r: Run) => boolean = () => true): TreeRow[] {
  return flattenFrom(f, f.roots().filter(filter));
}

/** Same walk from an explicit set of tops — used for the inline spawn tree. */
export function flattenFrom(f: Forest, tops: Run[]): TreeRow[] {
  const out: TreeRow[] = [];
  const seen = new Set<number>();
  const walk = (r: Run, prefix: string, last: boolean, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const kids = f.childrenOf(r.id);
    const branch = depth === 0 ? "" : prefix + (last ? "└ " : "├ ");
    out.push({ run: r, prefix: branch, depth });
    const next = depth === 0 ? "" : prefix + (last ? "  " : "│ ");
    kids.forEach((k, i) => walk(k, next, i === kids.length - 1, depth + 1));
  };
  tops.forEach((r, i) => walk(r, "", i === tops.length - 1, 0));
  return out;
}

/** Live subtrees first, then "earlier". A root counts as live if ANYTHING in
 *  its subtree is live, so a finished orchestrator with a working child stays
 *  on the top floor with its child under it. */
export function floorGroups(f: Forest): { live: TreeRow[]; rest: TreeRow[] } {
  const hot = new Set<number>();
  for (const r of f.runs) {
    if (!isLive(r.status)) continue;
    hot.add(r.id);
    for (const a of f.ancestors(r.id)) hot.add(a.id);
  }
  return {
    live: flatten(f, (r) => hot.has(r.id)),
    rest: flatten(f, (r) => !hot.has(r.id)),
  };
}
