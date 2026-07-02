"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2 } from "lucide-react";
import { StateIcon } from "./state-icon";
import {
  PLAN_TRANSITIONS,
  STATE_LABEL,
  TASK_TRANSITIONS,
  type PlanState,
  type TaskState,
} from "@/lib/types";
import { cn, describe } from "@/lib/utils";
import { usePrompt } from "@/components/ui/dialog-provider";

type Kind = "task" | "plan";

interface TaskProps {
  kind?: "task";
  taskId: string;
  current: TaskState;
  assignee: string | null;
}

interface PlanProps {
  kind: "plan";
  planId: string;
  current: PlanState;
}

type Props = TaskProps | PlanProps;

/**
 * Single popover button for advancing a task or plan through its state
 * machine. Reads the allowed next states from the corresponding TRANSITIONS
 * table; renders nothing-but-a-static-pill when there are no valid moves
 * (terminal states like done/cancelled). Tasks transitioning into
 * `in_progress` prompt for an assignee if one isn't set.
 */
export function StateChanger(props: Props) {
  const isTask = (props.kind ?? "task") === "task";
  const router = useRouter();
  const prompt = usePrompt();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const allowed: readonly string[] = isTask
    ? TASK_TRANSITIONS[(props as TaskProps).current]
    : PLAN_TRANSITIONS[(props as PlanProps).current];
  const current = (props as TaskProps | PlanProps).current;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const transition = async (next: string) => {
    setOpen(false);
    setError(null);

    let url: string;
    let body: Record<string, unknown>;
    let method: "POST" | "PATCH";
    if (isTask) {
      const tp = props as TaskProps;
      let assigneeOverride = tp.assignee ?? undefined;
      if (next === "in_progress" && !assigneeOverride) {
        const entered = await prompt({ title: "Assignee", placeholder: "username" });
        assigneeOverride = entered?.trim() || undefined;
        if (!assigneeOverride) return;
      }
      url = `/api/tasks/${tp.taskId}/transition`;
      method = "POST";
      body = { state: next, assignee: assigneeOverride };
    } else {
      const pp = props as PlanProps;
      url = `/api/plans/${pp.planId}`;
      method = "PATCH";
      body = { state: next };
    }

    startTransition(async () => {
      try {
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          setError(e.error ?? `HTTP ${res.status}`);
          return;
        }
        router.refresh();
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  return (
    <div ref={wrap} className="relative inline-block">
      <button
        type="button"
        onClick={() => allowed.length > 0 && setOpen((v) => !v)}
        disabled={pending || allowed.length === 0}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/60 px-2 py-0.5 text-xs font-medium text-foreground",
          allowed.length > 0 && "hover:bg-secondary",
          allowed.length === 0 && "opacity-60 cursor-default"
        )}
      >
        <StateIcon state={current as TaskState | PlanState} />
        {STATE_LABEL[current as TaskState | PlanState]}
        {pending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : allowed.length > 0 ? (
          <ChevronDown className="size-3 opacity-60" />
        ) : null}
      </button>
      {open && (
        <div className="absolute left-0 mt-1 z-20 min-w-[12rem] rounded-md border border-border bg-card p-1 shadow-lg">
          {allowed.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => transition(s)}
              className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs hover:bg-muted/60 text-left"
            >
              <StateIcon state={s as TaskState | PlanState} />
              {STATE_LABEL[s as TaskState | PlanState]}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="absolute left-0 top-full mt-1 text-[11px] text-state-blocked">
          {error}
        </p>
      )}
    </div>
  );
}
