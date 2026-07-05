"use client";

// Unified Chats + Runs index. Every chat is a run; runs may spawn child runs
// (parent_run_id). This one page is the place to start a chat (composer on
// top) and to monitor everything: run trees grouped by the most-active status
// in the tree, children nested under their parents, statuses kept live by a
// push-based SSE stream (GET /api/runs/overview/events) with the 6s poll of
// GET /api/runs/overview as an automatic fallback when the stream errors.

import * as React from "react";
import Link from "next/link";
import {
  GitPullRequest,
  MessagesSquare,
  Sparkles,
  Workflow,
  X,
  Zap,
} from "lucide-react";

import {
  buildRunForest,
  filterForest,
  groupForTree,
  kindForRun,
  latestActivity,
  runGoalTag,
  runHeading,
  treeSize,
  RUN_GROUPS,
  RUN_GROUP_LABEL,
  type RunGroup,
  type RunIndexRow,
  type RunKind,
  type RunTreeNode,
} from "@/lib/run-index";
import { formatDateTime, relativeDate, cn } from "@/lib/utils";
import { NewChatBox } from "@/components/new-chat-box";
import { SessionStatusPill } from "@/components/session-status-pill";
import { EmptyState } from "@/components/ui/empty-state";

const POLL_MS = 6000;
// While in poll-fallback mode (stream errored), periodically try to re-open the
// SSE stream so a transient network blip doesn't strand us on polling forever.
const STREAM_RETRY_MS = 45_000;

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

// ──────────────────────────────────────────────────────────
// Live rows: SSE stream with poll fallback, paused while hidden
// ──────────────────────────────────────────────────────────
//
// Primary path is a push-based EventSource on /api/runs/overview/events: the
// server sends `{ type:"rows", rows }` frames on every change (debounced),
// re-rendered with zero client polling. If the stream errors we fall back to
// the original 6s poll of /api/runs/overview, retrying the stream periodically.
// While the tab is hidden both the stream and the poll are suspended, and we
// reconnect/refresh immediately on becoming visible. `offline` means "can't
// refresh": it goes true only when the FALLBACK poll itself fails, matching the
// prior semantics (a healthy stream, or a stream error with a working poll,
// keeps us online).

function useLiveRows(initialRows: RunIndexRow[]): {
  rows: RunIndexRow[];
  offline: boolean;
} {
  const [rows, setRows] = React.useState(initialRows);
  const [offline, setOffline] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // `true` once the stream has errored: we stay on polling and periodically
    // try to re-establish the stream.
    let usePoll = false;

    // ── Poll fallback (the original 6s loop) ──────────────────────────────
    async function pollTick() {
      if (cancelled) return;
      if (!document.hidden) {
        try {
          const res = await fetch("/api/runs/overview", { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as { rows: RunIndexRow[] };
          if (cancelled) return;
          setRows(data.rows);
          setOffline(false);
        } catch {
          if (cancelled) return;
          setOffline(true);
        }
      }
      if (!cancelled && usePoll) pollTimer = setTimeout(pollTick, POLL_MS);
    }

    function startPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      // Refresh immediately so the fallback doesn't wait out a full interval.
      void pollTick();
    }

    function stopPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    }

    // ── SSE primary path ──────────────────────────────────────────────────
    function fallBackToPolling() {
      usePoll = true;
      closeStream();
      startPolling();
      // Keep trying to climb back onto the stream.
      if (!retryTimer) {
        retryTimer = setTimeout(function retry() {
          retryTimer = null;
          if (cancelled || document.hidden) return;
          usePoll = false;
          stopPolling();
          openStream();
        }, STREAM_RETRY_MS);
      }
    }

    function closeStream() {
      if (es) {
        es.close();
        es = null;
      }
    }

    function openStream() {
      if (cancelled || document.hidden) return;
      closeStream();
      const source = new EventSource("/api/runs/overview/events");
      es = source;
      source.onmessage = (e) => {
        if (cancelled) return;
        let msg: { type: string; rows?: RunIndexRow[] };
        try {
          msg = JSON.parse(e.data) as { type: string; rows?: RunIndexRow[] };
        } catch {
          return;
        }
        if (msg.type === "rows" && msg.rows) {
          setRows(msg.rows);
          setOffline(false);
        } else if (msg.type === "_eos") {
          // Server closed deliberately (e.g. unauthenticated). EventSource
          // would otherwise auto-reconnect forever, so drop to polling.
          fallBackToPolling();
        }
      };
      source.onerror = () => {
        // Transient network error or server hiccup: EventSource retries on its
        // own, but to preserve refresh coverage we switch to polling and retry
        // the stream on our own cadence.
        if (cancelled) return;
        fallBackToPolling();
      };
    }

    // ── Visibility: suspend everything while hidden ───────────────────────
    function suspend() {
      closeStream();
      stopPolling();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    }

    function resume() {
      if (cancelled) return;
      // Coming back to the tab always re-attempts the primary (stream) path;
      // if it errors again onerror drops us back to polling. This also avoids
      // getting stranded on polling when a stream-retry fired while hidden.
      usePoll = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      openStream();
    }

    const onVisible = () => {
      if (document.hidden) suspend();
      else resume();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Kick off on the primary (stream) path.
    openStream();

    return () => {
      cancelled = true;
      closeStream();
      stopPolling();
      if (retryTimer) clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { rows, offline };
}

// ──────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────

export function RunsIndex({
  initialRows,
  repositories,
  defaultModel,
  filterRepo,
  filterTask,
}: Props) {
  const { rows, offline } = useLiveRows(initialRows);
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

  const grouped = React.useMemo(() => {
    const byGroup = new Map<RunGroup, RunTreeNode[]>(RUN_GROUPS.map((g) => [g, []]));
    for (const t of visible) byGroup.get(groupForTree(t))!.push(t);
    for (const trees of byGroup.values()) {
      trees.sort((a, b) => latestActivity(b) - latestActivity(a));
    }
    return byGroup;
  }, [visible]);

  const totalRuns = visible.reduce((n, t) => n + treeSize(t), 0);
  const activeRuns = grouped.get("active")!.reduce((n, t) => n + treeSize(t), 0);
  const hasFilter = Boolean(filterRepo || filterTask);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
          <p className="text-sm text-muted-foreground">
            {totalRuns} total · chats and agent sessions, children under their parents.
          </p>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {offline ? (
              <span className="text-state-blocked">refresh offline</span>
            ) : (
              <>
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    activeRuns > 0 ? "bg-state-progress animate-pulse" : "bg-muted-foreground/50"
                  )}
                />
                live
              </>
            )}
          </span>
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

      {visible.length === 0 ? (
        <EmptyState>
          {kindTab === "chat" ? "No chats yet — start one above." : "No runs yet."}
        </EmptyState>
      ) : (
        RUN_GROUPS.map((group) => {
          const trees = grouped.get(group)!;
          if (trees.length === 0) return null;
          const runCount = trees.reduce((n, t) => n + treeSize(t), 0);
          return (
            <section key={group} className="space-y-1.5">
              <div className="flex items-center gap-2 px-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {RUN_GROUP_LABEL[group]}
                </h2>
                <span className="text-xs text-muted-foreground tabular-nums">{runCount}</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-card/30 divide-y divide-border/60 overflow-hidden">
                {trees.map((tree) => (
                  <TreeBlock key={tree.run.id} tree={tree} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Tree rendering
// ──────────────────────────────────────────────────────────

function TreeBlock({ tree }: { tree: RunTreeNode }) {
  return (
    <div>
      <RootRow node={tree} />
      <ChildRows nodes={tree.children} depth={1} />
    </div>
  );
}

function ChildRows({ nodes, depth }: { nodes: RunTreeNode[]; depth: number }) {
  return (
    <>
      {nodes.map((n) => (
        <React.Fragment key={n.run.id}>
          <ChildRow node={n} depth={depth} />
          <ChildRows nodes={n.children} depth={depth + 1} />
        </React.Fragment>
      ))}
    </>
  );
}

function iconFor(run: RunIndexRow) {
  if (run.goal === "<chat>") return MessagesSquare;
  if (run.goal === "<review>") return GitPullRequest;
  if (run.goal === "<execute>") return Workflow;
  return Sparkles;
}

function RootRow({ node }: { node: RunTreeNode }) {
  const run = node.run;
  const Icon = iconFor(run);
  const childCount = treeSize(node) - 1;
  const goalTag = runGoalTag(run);
  return (
    <div className="px-4 py-3 hover:bg-muted/40 transition-colors">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`/runs/${run.id}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 flex-1 min-w-0"
        >
          <Icon className="size-3.5 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground tabular-nums">#{run.id}</span>
          <span className="text-sm font-medium">{runHeading(run)}</span>
          {goalTag && (
            <span className="font-mono text-[11px] text-muted-foreground">{goalTag}</span>
          )}
          <SessionStatusPill status={run.status} />
          <EventBadges run={run} />
          {run.taskId && kindForRun(run) === "agent" && (
            <span className="font-mono text-[11px] text-muted-foreground">{run.taskId}</span>
          )}
          {childCount > 0 && (
            <span className="rounded-md border border-border/60 bg-secondary/40 px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">
              {childCount} sub-run{childCount === 1 ? "" : "s"}
            </span>
          )}
        </Link>
        {run.prUrl && <PrLink href={run.prUrl} />}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>started {relativeDate(new Date(run.startedAt))}</span>
        {run.completedAt && <span>· {formatDateTime(new Date(run.completedAt))}</span>}
        {run.model && <span className="font-mono">{run.model}</span>}
        {run.repoName && <span>· {run.repoName}</span>}
        {run.totalCostUsd !== null && <span>· ${run.totalCostUsd.toFixed(4)}</span>}
        {run.error && <span className="text-state-blocked">{run.error}</span>}
      </div>
    </div>
  );
}

// Nested (spawned) run — indented one step per depth level under its parent,
// compact single line so a busy executor's children scan as one block.
function ChildRow({ node, depth }: { node: RunTreeNode; depth: number }) {
  const run = node.run;
  const Icon = iconFor(run);
  const goalTag = runGoalTag(run);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pr-4 text-xs hover:bg-muted/40 transition-colors border-t border-border/40"
      style={{ paddingLeft: 16 + Math.min(depth, 4) * 22 }}
    >
      <Link
        href={`/runs/${run.id}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 flex-1 min-w-0"
      >
        <span className="text-muted-foreground/70 select-none" aria-hidden>
          ↳
        </span>
        <Icon className="size-3 text-muted-foreground" />
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          #{run.id}
        </span>
        <span className="font-medium truncate">{runHeading(run)}</span>
        {goalTag && (
          <span className="font-mono text-[11px] text-muted-foreground">{goalTag}</span>
        )}
        <SessionStatusPill status={run.status} />
        <EventBadges run={run} />
        {run.error && (
          <span className="min-w-0 truncate text-state-blocked">{run.error}</span>
        )}
      </Link>
      <span className="text-[11px] text-muted-foreground">
        {relativeDate(new Date(run.startedAt))}
      </span>
      {run.totalCostUsd !== null && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          ${run.totalCostUsd.toFixed(4)}
        </span>
      )}
      {run.prUrl && <PrLink href={run.prUrl} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Small pieces
// ──────────────────────────────────────────────────────────

// Agent-event visibility (docs/agent-events.md §11): why a parked run is
// parked, and how many owner-audience events are queued to wake it — so
// "parked (sleeping, 3 events queued)" is readable straight off the index.
function EventBadges({ run }: { run: RunIndexRow }) {
  return (
    <>
      {run.status === "parked" && run.parkReason && (
        <span className="text-[11px] text-state-review">{run.parkReason}</span>
      )}
      {run.pendingEvents > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-state-progress/30 bg-state-progress/10 px-1.5 py-0.5 text-[11px] text-state-progress tabular-nums"
          title="Pending inbox events addressed to this run — delivery wakes it"
        >
          <Zap className="size-3" />
          {run.pendingEvents} queued
        </span>
      )}
    </>
  );
}

function PrLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[11px] text-muted-foreground hover:text-foreground underline decoration-dotted"
    >
      PR ↗
    </a>
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
    <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-secondary/40 pl-2 pr-1 py-0.5 text-xs">
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
