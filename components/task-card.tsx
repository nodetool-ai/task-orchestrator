import Link from "next/link";
import { GitPullRequest } from "lucide-react";
import type { TaskFull } from "@/lib/types";
import { StateIcon } from "./state-icon";
import { prShortLabel } from "@/lib/utils";

export function TaskCard({ task }: { task: TaskFull }) {
  const open = task.criteria?.filter((c) => !c.done).length ?? 0;
  const total = task.criteria?.length ?? 0;
  return (
    <div className="group relative rounded-md border border-border/70 bg-card/40 hover:bg-card hover:border-border transition-colors p-3">
      {/* Stretched link covers the card; the PR link rides above it. */}
      <Link
        href={`/tasks/${task.id}`}
        aria-label={task.title}
        className="absolute inset-0 rounded-md"
      />
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
        <StateIcon state={task.state} />
        <span className="tabular-nums">{task.id}</span>
        <div className="ml-auto flex items-center gap-2">
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              title={prShortLabel(task.prUrl)}
              className="relative z-10 inline-flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <GitPullRequest className="size-3 text-state-review" />
            </a>
          )}
          {total > 0 && (
            <span className="tabular-nums">
              {total - open}/{total}
            </span>
          )}
        </div>
      </div>
      <div className="mt-1.5 text-sm font-medium leading-snug text-foreground line-clamp-3">
        {task.title}
      </div>
      {task.assignee || task.tags?.length ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {task.assignee && <span>@{task.assignee}</span>}
          {task.tags?.slice(0, 3).map((t) => (
            <span key={t} className="rounded border border-border/70 px-1.5 py-px">
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
