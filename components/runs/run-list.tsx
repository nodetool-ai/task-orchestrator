"use client";

// The run list, shared by /runs and the home page so both read the same way.
//
// One line per run: what it is, whether it wants you, what it's doing, when it
// last moved. Everything else (id, model, cost, repo, task, budget, the error
// text, the PR link) lives on the run page, one click away. Child runs nest
// under their parent, indented one step per level, so a busy executor's
// specialists scan as one block instead of competing for the top of the page.

import * as React from "react";
import Link from "next/link";
import { GitPullRequest, MessagesSquare, Sparkles, Workflow, Zap } from "lucide-react";

import {
  groupTrees,
  orderTrees,
  runHeading,
  treeSize,
  RUN_GROUPS,
  RUN_GROUP_LABEL,
  type RunIndexRow,
  type RunTreeNode,
} from "@/lib/run-index";
import { relativeDate, cn } from "@/lib/utils";
import { SessionStatusPill } from "@/components/session-status-pill";
import { EmptyState } from "@/components/ui/empty-state";

interface Props {
  /** Run trees to render, already filtered by the caller. */
  trees: RunTreeNode[];
  /** Render at most this many trees, in the order the full list shows them. */
  limit?: number;
  /** Line shown in place of the list when there is nothing to render. */
  empty?: string;
}

export function RunList({ trees, limit, empty = "No runs yet." }: Props) {
  const shown = React.useMemo(
    () => (limit == null ? trees : orderTrees(trees).slice(0, limit)),
    [trees, limit]
  );
  const grouped = React.useMemo(() => groupTrees(shown), [shown]);

  if (shown.length === 0) return <EmptyState>{empty}</EmptyState>;

  return (
    <div className="space-y-5">
      {RUN_GROUPS.map((group) => {
        const bucket = grouped.get(group)!;
        if (bucket.length === 0) return null;
        const runCount = bucket.reduce((n, t) => n + treeSize(t), 0);
        return (
          <section key={group} className="space-y-1.5">
            <div className="flex items-center gap-2 px-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {RUN_GROUP_LABEL[group]}
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums">{runCount}</span>
            </div>
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-card/30">
              {bucket.map((tree) => (
                <div key={tree.run.id}>
                  <RunRow node={tree} depth={0} />
                  <ChildRows nodes={tree.children} depth={1} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ChildRows({ nodes, depth }: { nodes: RunTreeNode[]; depth: number }) {
  return (
    <>
      {nodes.map((n) => (
        <React.Fragment key={n.run.id}>
          <RunRow node={n} depth={depth} />
          <ChildRows nodes={n.children} depth={depth + 1} />
        </React.Fragment>
      ))}
    </>
  );
}

function RunRow({ node, depth }: { node: RunTreeNode; depth: number }) {
  const run = node.run;
  const Icon = iconFor(run);
  const isChild = depth > 0;
  // Only a root carries the count: nested rows are already visible below it.
  const childCount = isChild ? 0 : treeSize(node) - 1;
  return (
    <Link
      href={`/runs/${run.id}`}
      title={rowTitle(run)}
      className={cn(
        "flex items-center gap-2.5 transition-colors hover:bg-muted/40",
        isChild ? "border-t border-border/40 py-1.5 pr-3 text-xs" : "px-3 py-2.5 text-sm"
      )}
      style={isChild ? { paddingLeft: 12 + Math.min(depth, 4) * 18 } : undefined}
    >
      <Icon className={cn("shrink-0 text-muted-foreground", isChild ? "size-3" : "size-3.5")} />
      <span className={cn("min-w-0 flex-1 truncate", isChild ? undefined : "font-medium")}>
        {runHeading(run)}
      </span>
      {childCount > 0 && (
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {childCount} sub-run{childCount === 1 ? "" : "s"}
        </span>
      )}
      {run.pendingEvents > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-state-progress tabular-nums"
          title="Pending inbox events addressed to this run (delivery wakes it)"
        >
          <Zap className="size-3" />
          {run.pendingEvents}
        </span>
      )}
      <SessionStatusPill status={run.status} />
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {relativeDate(new Date(run.startedAt))}
      </span>
    </Link>
  );
}

function iconFor(run: RunIndexRow) {
  if (run.goal === "<chat>") return MessagesSquare;
  if (run.goal === "<review>") return GitPullRequest;
  if (run.goal === "<execute>") return Workflow;
  return Sparkles;
}

// The details the row no longer prints are still one hover away, so nothing an
// operator needs to quote (the run id, why a run is parked, what failed) got
// lost in the cleanup.
function rowTitle(run: RunIndexRow): string {
  const parts = [`Run #${run.id}`];
  if (run.parkReason) parts.push(run.parkReason);
  if (run.pendingReason) parts.push(run.pendingReason);
  if (run.repoName) parts.push(run.repoName);
  if (run.error) parts.push(run.error);
  return parts.join(" · ");
}
