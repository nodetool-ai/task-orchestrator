import Link from "next/link";
import { X, MessagesSquare, Sparkles } from "lucide-react";
import * as repo from "@/lib/repo";
import {
  listRuns,
  groupForStatus,
  RUN_GROUPS,
  RUN_GROUP_LABEL,
  type RunGroup,
  type RunRow,
} from "@/lib/runs";
import { formatDateTime, relativeDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface SearchParams {
  repo?: string;
  task?: string;
}

export default async function RunsIndexPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filterRepo = sp.repo;
  const filterTask = sp.task;
  const hasFilter = Boolean(filterRepo || filterTask);

  const runs = listRuns({ repoId: filterRepo, taskId: filterTask });
  const repos = repo.listRepositories();
  const repoNames = new Map(repos.map((r) => [r.id, r.name]));
  const taskTitles = new Map(repo.listTasks().map((t) => [t.id, t.title]));

  const grouped: Array<{ group: RunGroup; runs: RunRow[] }> = RUN_GROUPS.map((g) => ({
    group: g,
    runs: runs.filter((r) => groupForStatus(r.status) === g),
  })).filter((g) => g.runs.length > 0);

  const sansParam = (drop: keyof SearchParams) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === drop || !v) continue;
      next.set(k, String(v));
    }
    const qs = next.toString();
    return qs ? `/runs?${qs}` : "/runs";
  };

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
          <p className="text-sm text-muted-foreground">
            {runs.length} total · agent sessions and chats, grouped by status.
          </p>
        </div>
        {hasFilter && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Filters</span>
            {filterRepo && (
              <FilterChip
                label={`Repo: ${repoNames.get(filterRepo) ?? filterRepo}`}
                clearTo={sansParam("repo")}
              />
            )}
            {filterTask && (
              <FilterChip
                label={`Task: ${taskTitles.get(filterTask) ?? filterTask}`}
                clearTo={sansParam("task")}
              />
            )}
            <Link href="/runs" className="ml-1 text-[11px] text-muted-foreground hover:text-foreground">
              clear all
            </Link>
          </div>
        )}
      </header>

      {grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        grouped.map((group) => (
          <section key={group.group} className="space-y-1.5">
            <div className="flex items-center gap-2 px-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {RUN_GROUP_LABEL[group.group]}
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums">{group.runs.length}</span>
            </div>
            <div className="rounded-lg border border-border/60 bg-card/30 divide-y divide-border/60 overflow-hidden">
              {group.runs.map((r) => (
                <RunRowItem
                  key={r.id}
                  run={r}
                  repoName={r.repoId ? repoNames.get(r.repoId) ?? null : null}
                  taskTitle={r.taskId ? taskTitles.get(r.taskId) ?? null : null}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function RunRowItem({
  run,
  repoName,
  taskTitle,
}: {
  run: RunRow;
  repoName: string | null;
  taskTitle: string | null;
}) {
  const Icon = run.origin === "chat" ? MessagesSquare : Sparkles;
  const heading =
    run.origin === "chat"
      ? run.title ?? "Chat"
      : taskTitle ?? run.taskId ?? `Run #${run.id}`;
  return (
    <div className="px-4 py-3 hover:bg-muted/40 transition-colors">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`/runs/${run.id}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 flex-1 min-w-0"
        >
          <Icon className="size-3.5 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground tabular-nums">#{run.id}</span>
          <span className="text-sm font-medium">{heading}</span>
          <RunStatusPill status={run.status} />
          {run.origin === "task" && run.taskId && (
            <span className="font-mono text-[11px] text-muted-foreground">{run.taskId}</span>
          )}
        </Link>
        {run.prUrl && (
          <a
            href={run.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-muted-foreground hover:text-foreground underline decoration-dotted"
          >
            PR ↗
          </a>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>started {relativeDate(run.startedAt)}</span>
        {run.completedAt && <span>· {formatDateTime(run.completedAt)}</span>}
        {run.model && <span className="font-mono">{run.model}</span>}
        {repoName && <span>· {repoName}</span>}
        {run.totalCostUsd !== null && <span>· ${run.totalCostUsd.toFixed(4)}</span>}
        {run.error && <span className="text-state-blocked">{run.error}</span>}
      </div>
    </div>
  );
}

function FilterChip({ label, clearTo }: { label: string; clearTo: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-secondary/40 pl-2 pr-1 py-0.5 text-xs">
      {label}
      <Link href={clearTo} aria-label="Clear" className="text-muted-foreground hover:text-foreground">
        <X className="size-3" />
      </Link>
    </span>
  );
}

// Tone-mapped pill for any run status (covers SessionStatus + 'idle').
const STATUS_TONE: Record<string, string> = {
  pending: "text-muted-foreground",
  idle: "text-muted-foreground",
  preparing: "text-state-progress",
  running: "text-state-progress",
  pushing: "text-state-review",
  opening_pr: "text-state-review",
  completed: "text-state-done",
  failed: "text-state-blocked",
  cancelled: "text-muted-foreground",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  idle: "Idle",
  preparing: "Preparing",
  running: "Running",
  pushing: "Pushing",
  opening_pr: "Opening PR",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function RunStatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "text-muted-foreground";
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/60 px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  );
}
