import Link from "next/link";
import type { TaskFull } from "@/lib/types";
import { StateIcon } from "./state-icon";
import { Chip } from "@/components/ui/chip";
import { PrLink } from "@/components/pr-link";

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
          {task.prUrl && <PrLink url={task.prUrl} label="none" iconClassName="size-3" />}
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
            <Chip key={t} className="bg-transparent px-1.5 py-px text-[11px]">
              {t}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
