"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  GitChangeSet,
  GitChangeStatus,
  GitFileChange,
  RunGitStatus,
} from "@/lib/run-git-status";

// The run's git state: what its checkout changed, in files and in lines.
// Seeded from the server render so opening the panel is instant; the refresh
// button re-reads GET /api/runs/:id/git-status for a run that is still working.
//
// Two change sets, because they mean different things: `committed` is what the
// branch carries on top of its base (what a PR would contain), `working` is
// what is still uncommitted in the worktree (staged, unstaged, untracked).

type Scope = "all" | "committed" | "working";

const SCOPES: Array<{ id: Scope; label: string }> = [
  { id: "all", label: "All" },
  { id: "committed", label: "Committed" },
  { id: "working", label: "Uncommitted" },
];

const STATUS_LABEL: Record<GitChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "?",
};

const STATUS_TONE: Record<GitChangeStatus, string> = {
  added: "bg-state-done/10 text-state-done",
  modified: "bg-state-progress/10 text-state-progress",
  deleted: "bg-state-blocked/10 text-state-blocked",
  renamed: "bg-state-review/10 text-state-review",
  copied: "bg-state-review/10 text-state-review",
  typechange: "bg-muted/60 text-muted-foreground",
  untracked: "bg-muted/60 text-muted-foreground",
};

export function GitStatusPanel({
  runId,
  initial,
}: {
  runId: number;
  initial: RunGitStatus | null;
}) {
  const [data, setData] = useState<RunGitStatus | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // A live run's tree changes under us — never serve this from a cache.
      const res = await fetch(`/api/runs/${runId}/git-status`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as RunGitStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // Fetch on open only when the server render had nothing to seed us with.
  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);

  // Nothing to summarise or filter when there is no checkout to read.
  const totals = data?.available ? totalsOf(data, scope) : null;
  const sections = data?.available ? sectionsFor(data, scope) : [];
  const anyFiles = sections.some((s) => s.set.files.length > 0);

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-background/60 text-[11px]">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5 text-muted-foreground">
        <span className="font-semibold text-foreground">Changes</span>
        {totals && (
          <>
            <span className="tabular-nums">
              {totals.files} file{totals.files === 1 ? "" : "s"}
            </span>
            <DiffCounts additions={totals.additions} deletions={totals.deletions} />
          </>
        )}
        {data?.branch && (
          <span className="truncate font-mono">
            {data.branch}
            {data.base ? ` → ${data.base}` : ""}
          </span>
        )}
        {data?.ahead != null && data.ahead > 0 && (
          <span className="rounded bg-muted/60 px-1.5 py-0.5 tabular-nums">
            {data.ahead} commit{data.ahead === 1 ? "" : "s"} ahead
          </span>
        )}
        {data?.available && (
          <div
            role="tablist"
            aria-label="Filter changes by scope"
            className="ml-auto inline-flex rounded border border-border/60 bg-secondary/40 p-0.5"
          >
            {SCOPES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={scope === s.id}
                onClick={() => setScope(s.id)}
                className={cn(
                  "rounded px-1.5 py-0.5 transition-colors",
                  scope === s.id
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-50",
            !data?.available && "ml-auto"
          )}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          refresh
        </button>
      </div>

      {error && (
        <p role="alert" className="px-3 py-2 text-state-blocked">
          failed to load: {error}
        </p>
      )}
      {!error && !data && (
        <p className="px-3 py-2 text-muted-foreground/60">loading…</p>
      )}
      {!error && data && !data.available && (
        <p className="px-3 py-2 text-muted-foreground/70">
          {data.reason ?? "No checkout to inspect for this run."}
        </p>
      )}
      {!error && data?.available && !anyFiles && (
        <p className="px-3 py-2 text-muted-foreground/60">
          {scope === "committed"
            ? "Nothing committed on this branch yet."
            : scope === "working"
              ? "The worktree is clean."
              : "No changes in this run's checkout."}
        </p>
      )}
      {!error && data?.available && anyFiles && (
        <div className="max-h-80 overflow-auto">
          {sections
            .filter((s) => s.set.files.length > 0)
            .map((section) => (
              <div key={section.id}>
                {scope === "all" && (
                  <div className="sticky top-0 flex items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {section.title}
                    <DiffCounts
                      additions={section.set.additions}
                      deletions={section.set.deletions}
                    />
                  </div>
                )}
                <ul className="divide-y divide-border/40">
                  {section.set.files.map((file) => (
                    <FileRow key={`${section.id}-${file.path}`} file={file} />
                  ))}
                </ul>
                {section.set.truncated > 0 && (
                  <p className="px-3 py-1 text-muted-foreground/60">
                    + {section.set.truncated} more file
                    {section.set.truncated === 1 ? "" : "s"} not listed
                  </p>
                )}
              </div>
            ))}
        </div>
      )}
      {data?.cwd && (
        <p className="truncate border-t border-border/60 px-3 py-1 font-mono text-[10px] text-muted-foreground/60">
          {data.cwd}
        </p>
      )}
    </div>
  );
}

function FileRow({ file }: { file: GitFileChange }) {
  const dir = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
    : "";
  const name = file.path.slice(dir.length);
  return (
    <li className="flex items-center gap-2 px-3 py-1 hover:bg-muted/30">
      <span
        className={cn(
          "w-4 shrink-0 rounded text-center font-mono",
          STATUS_TONE[file.status]
        )}
        title={file.status}
      >
        {STATUS_LABEL[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
        {file.oldPath && (
          <span className="text-muted-foreground/60">{file.oldPath} → </span>
        )}
        <span className="text-muted-foreground/60">{dir}</span>
        <span className="text-foreground">{name}</span>
      </span>
      {file.staged && (
        <span className="shrink-0 rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
          staged
        </span>
      )}
      {file.binary ? (
        <span className="shrink-0 text-muted-foreground/60">binary</span>
      ) : (
        <DiffCounts additions={file.additions ?? 0} deletions={file.deletions ?? 0} />
      )}
    </li>
  );
}

export function DiffCounts({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cn("shrink-0 tabular-nums", className)}>
      <span className="text-state-done">+{additions}</span>{" "}
      <span className="text-state-blocked">−{deletions}</span>
    </span>
  );
}

function sectionsFor(
  status: RunGitStatus,
  scope: Scope
): Array<{ id: string; title: string; set: GitChangeSet }> {
  const committed = { id: "committed", title: "Committed on branch", set: status.committed };
  const working = { id: "working", title: "Uncommitted in worktree", set: status.working };
  if (scope === "committed") return [committed];
  if (scope === "working") return [working];
  return [committed, working];
}

function totalsOf(status: RunGitStatus, scope: Scope) {
  const sets = sectionsFor(status, scope).map((s) => s.set);
  const paths = new Set(sets.flatMap((s) => s.files.map((f) => f.path)));
  return {
    files: paths.size + sets.reduce((n, s) => n + s.truncated, 0),
    additions: sets.reduce((n, s) => n + s.additions, 0),
    deletions: sets.reduce((n, s) => n + s.deletions, 0),
  };
}

/**
 * Files/lines across both change sets — what the run header's toggle shows.
 * Lives here (a client module) so the header can read it without pulling the
 * server-only collector into the browser bundle.
 */
export function summarizeGitStatus(status: RunGitStatus): {
  files: number;
  additions: number;
  deletions: number;
} {
  return totalsOf(status, "all");
}
