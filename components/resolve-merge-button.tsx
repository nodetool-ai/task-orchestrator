"use client";

import { useEffect, useState } from "react";
import { GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  taskId: string;
  className?: string;
}

interface MergeableResp {
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  baseRef: string | null;
  attachedRunId: number | null;
}

/**
 * Shown only when GitHub reports the task's PR as CONFLICTING and the task has
 * an attached run. Clicking posts the merge prompt into that same run (so the
 * agent merges/resolves with full context) and opens the streaming run view.
 */
export function ResolveMergeButton({ taskId, className }: Props) {
  const [info, setInfo] = useState<MergeableResp | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/tasks/${taskId}/mergeable`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MergeableResp | null) => {
        if (alive) setInfo(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [taskId]);

  const show =
    info?.mergeable === "CONFLICTING" && typeof info.attachedRunId === "number";
  if (!show) return null;

  const runId = info!.attachedRunId!;

  const resolve = () => {
    setSent(true);
    // Fire-and-forget the merge turn (the server builds the canonical prompt
    // from the base-ref hint), then open the attached run in a new tab — the
    // task page stays mounted so the streaming POST isn't torn down by nav.
    void fetch(`/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolveMergeBaseRef: info!.baseRef }),
    }).catch(() => {
      // The /runs/[id] page surfaces any error.
    });
    window.open(`/runs/${runId}`, "_blank", "noopener,noreferrer");
  };

  return (
    <button
      type="button"
      onClick={resolve}
      disabled={sent}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-state-blocked/50 bg-transparent px-3 py-1.5 text-xs font-medium text-state-blocked",
        "hover:bg-state-blocked/10 transition-colors disabled:opacity-60",
        className
      )}
    >
      <GitMerge className="size-3.5" />
      Resolve merge
    </button>
  );
}
