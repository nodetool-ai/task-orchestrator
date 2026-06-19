import Link from "next/link";
import { GitPullRequest } from "lucide-react";
import type { TaskFull } from "@/lib/types";
import { StateIcon } from "./state-icon";
import { prShortLabel, relativeDate } from "@/lib/utils";

export function TaskRow({ task }: { task: TaskFull }) {
  return (
    <div className="group relative flex items-center gap-3 px-3 py-2.5 -mx-3 rounded-md hover:bg-muted/60 transition-colors">
      {/* Stretched link: whole row navigates to the task. Interactive children
          (the PR link) sit above it with relative z-10. */}
      <Link
        href={`/tasks/${task.id}`}
        aria-label={task.title}
        className="absolute inset-0 rounded-md"
      />
      <StateIcon state={task.state} />
      <span className="font-mono text-xs text-muted-foreground tabular-nums">{task.id}</span>
      <span className="flex-1 truncate text-sm text-foreground">{task.title}</span>
      {task.tags?.slice(0, 2).map((t) => (
        <span
          key={t}
          className="hidden sm:inline-block rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {t}
        </span>
      ))}
      {task.assignee && (
        <span className="hidden md:inline-block text-xs text-muted-foreground">
          @{task.assignee}
        </span>
      )}
      {task.prUrl && (
        <a
          href={task.prUrl}
          target="_blank"
          rel="noreferrer"
          title={prShortLabel(task.prUrl)}
          className="relative z-10 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <GitPullRequest className="size-3.5 text-state-review" />
          <span className="hidden sm:inline font-mono">{prShortLabel(task.prUrl)}</span>
        </a>
      )}
      <span className="hidden lg:inline-block text-xs text-muted-foreground tabular-nums w-20 text-right">
        {relativeDate(task.updatedAt)}
      </span>
    </div>
  );
}
