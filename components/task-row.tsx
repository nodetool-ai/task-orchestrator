import Link from "next/link";
import type { TaskFull } from "@/lib/types";
import { StateIcon } from "./state-icon";
import { relativeDate } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { PrLink } from "@/components/pr-link";

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
        <Chip key={t} className="hidden bg-transparent px-1.5 py-0.5 text-[10px] uppercase tracking-wide sm:inline-flex">
          {t}
        </Chip>
      ))}
      {task.assignee && (
        <span className="hidden md:inline-block text-xs text-muted-foreground">
          @{task.assignee}
        </span>
      )}
      {task.prUrl && <PrLink url={task.prUrl} label="number" />}
      <span className="hidden lg:inline-block text-xs text-muted-foreground tabular-nums w-20 text-right">
        {relativeDate(task.updatedAt)}
      </span>
    </div>
  );
}
