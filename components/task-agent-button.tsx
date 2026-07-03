"use client";

import { Spinner } from "@/components/ui/spinner";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { cn, describe } from "@/lib/utils";

interface Props {
  taskId: string;
  /** Whether the task already has a usable attached run (server-resolved). */
  hasAttachedRun: boolean;
  className?: string;
}

/**
 * One-click entry to a task's single attached run. Opens it if it exists,
 * otherwise creates it (seeded with the implement prompt) and navigates to the
 * streaming /runs/[id] view. Replaces the old Run-agent / Run-review buttons.
 */
export function TaskAgentButton({ taskId, hasAttachedRun, className }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const go = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/attached-run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seed: true }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        const { runId } = (await res.json()) as { runId: number };
        router.push(`/runs/${runId}`);
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={go}
        disabled={pending}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 text-xs font-medium",
          "hover:bg-muted transition-colors disabled:opacity-60",
          className
        )}
      >
        {pending ? (
          <Spinner className="size-3.5" />
        ) : (
          <Sparkles className="size-3.5 text-state-review" />
        )}
        {hasAttachedRun ? "Open agent" : "Start agent"}
      </button>
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  );
}
