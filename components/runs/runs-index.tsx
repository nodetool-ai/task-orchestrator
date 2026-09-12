"use client";

// Unified Chats + Runs index. Every chat is a run; runs may spawn child runs
// (parent_run_id). This one page is the place to start a chat (composer on
// top) and to monitor everything, with the run rows themselves rendered by the
// shared <RunList> the home page also uses, so the two never drift apart.
// Rows stay live through the shared SSE stream (with a poll fallback).

import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";

import {
  buildRunForest,
  filterForest,
  groupForTree,
  kindForRun,
  treeSize,
  type RunIndexRow,
  type RunKind,
} from "@/lib/run-index";
import { cn } from "@/lib/utils";
import { NewChatBox } from "@/components/new-chat-box";
import { RunList } from "@/components/runs/run-list";
import { useLiveRuns } from "@/components/runs/use-live-runs";

interface Props {
  initialRows: RunIndexRow[];
  repositories: Array<{ id: string; name: string }>;
  defaultModel: string;
  filterRepo: { id: string; name: string } | null;
  filterTask: { id: string; title: string } | null;
}

type KindTab = "all" | RunKind;

const KIND_TAB_LABEL: Record<KindTab, string> = {
  all: "All",
  chat: "Chats",
  agent: "Agent runs",
};

export function RunsIndex({
  initialRows,
  repositories,
  defaultModel,
  filterRepo,
  filterTask,
}: Props) {
  const { rows, offline } = useLiveRuns(initialRows);
  const [kindTab, setKindTab] = React.useState<KindTab>("all");

  const forest = React.useMemo(() => buildRunForest(rows), [rows]);
  const scoped = React.useMemo(
    () =>
      filterForest(forest, {
        repoId: filterRepo?.id ?? null,
        taskId: filterTask?.id ?? null,
      }),
    [forest, filterRepo, filterTask]
  );
  const kindCounts = React.useMemo(() => {
    const counts: Record<KindTab, number> = { all: scoped.length, chat: 0, agent: 0 };
    for (const t of scoped) counts[kindForRun(t.run)]++;
    return counts;
  }, [scoped]);
  const visible = React.useMemo(
    () => filterForest(scoped, { kind: kindTab === "all" ? null : kindTab }),
    [scoped, kindTab]
  );

  // Live dot: runs in a tree that has anything active in it, matching the
  // grouping the list itself uses.
  const activeRuns = React.useMemo(
    () =>
      visible
        .filter((t) => groupForTree(t) === "active")
        .reduce((n, t) => n + treeSize(t), 0),
    [visible]
  );
  const hasFilter = Boolean(filterRepo || filterTask);

  return (
    <div className="mx-auto max-w-[1480px] space-y-6 px-3 py-4 pb-24 sm:px-5 sm:py-5 sm:pb-20">
      <header className="space-y-3">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
          <span
            title={offline ? "Refresh offline" : activeRuns > 0 ? "Live, runs active" : "Live"}
            className={cn(
              "size-1.5 rounded-full",
              offline
                ? "bg-state-blocked"
                : activeRuns > 0
                  ? "bg-state-progress animate-pulse"
                  : "bg-muted-foreground/40"
            )}
          />
        </div>
        <NewChatBox defaultModel={defaultModel} repositories={repositories} />
        <div className="flex flex-wrap items-center gap-2">
          <KindTabs value={kindTab} counts={kindCounts} onChange={setKindTab} />
          {hasFilter && (
            <div className="flex flex-wrap items-center gap-1.5">
              {filterRepo && (
                <FilterChip
                  label={`Repo: ${filterRepo.name}`}
                  clearTo={filterTask ? `/runs?task=${filterTask.id}` : "/runs"}
                />
              )}
              {filterTask && (
                <FilterChip
                  label={`Task: ${filterTask.title}`}
                  clearTo={filterRepo ? `/runs?repo=${filterRepo.id}` : "/runs"}
                />
              )}
              <Link
                href="/runs"
                className="ml-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                clear all
              </Link>
            </div>
          )}
        </div>
      </header>

      <RunList
        trees={visible}
        empty={kindTab === "chat" ? "No chats yet, start one above." : "No runs yet."}
      />
    </div>
  );
}

function KindTabs({
  value,
  counts,
  onChange,
}: {
  value: KindTab;
  counts: Record<KindTab, number>;
  onChange: (v: KindTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Run kind"
      className="inline-flex rounded-md border border-border/60 bg-secondary/40 p-0.5 text-xs"
    >
      {(Object.keys(KIND_TAB_LABEL) as KindTab[]).map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={value === tab}
          onClick={() => onChange(tab)}
          className={cn(
            "rounded px-2.5 py-1 font-medium transition-colors",
            value === tab
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {KIND_TAB_LABEL[tab]}
          <span className="ml-1.5 tabular-nums text-muted-foreground">{counts[tab]}</span>
        </button>
      ))}
    </div>
  );
}

function FilterChip({ label, clearTo }: { label: string; clearTo: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-secondary/40 py-0.5 pl-2 pr-1 text-xs">
      {label}
      <Link
        href={clearTo}
        aria-label="Clear filter"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-3" />
      </Link>
    </span>
  );
}
