"use client";

import { useEffect, useState } from "react";
import { GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorText } from "@/components/ui/error-text";

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
  const [error, setError] = useState<string | null>(null);

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

  const resolve = async () => {
    setSent(true);
    setError(null);

    // Open the run tab synchronously (inside the click gesture) so the popup
    // blocker doesn't kill it after the awaited fetch. Same-origin, so we
    // navigate the handle once the turn is accepted.
    const popup = window.open("", "_blank");

    try {
      // Post the merge turn (the server builds the canonical prompt from the
      // base-ref hint) and read the first SSE frame. If the attached run is
      // mid-turn it answers `{type:'error', 'already in flight'}` immediately —
      // surface that and re-enable the button instead of dropping it silently.
      const res = await fetch(`/api/runs/${runId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolveMergeBaseRef: info!.baseRef }),
      });
      if (!res.ok || !res.body) {
        popup?.close();
        setError(`HTTP ${res.status}`);
        setSent(false);
        return;
      }
      const { event, drain } = await readFirstSseEvent(res.body);
      // Keep draining in the background so the merge turn isn't cancelled —
      // aborting the POST stream would abort the agent's turn.
      void drain();
      if (event?.type === "error") {
        popup?.close();
        setError(event.error ?? "The run is busy — try again in a moment.");
        setSent(false);
        return;
      }

      // Accepted — reveal the run (or fall back to a link if the popup was
      // blocked). The button stays disabled to avoid duplicate merge turns.
      if (popup) popup.location.href = `/runs/${runId}`;
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : String(err));
      setSent(false);
    }
  };

  return (
    <div className="flex flex-col items-start sm:items-end gap-1">
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
      <ErrorText className="text-[11px]">{error}</ErrorText>
      {sent && !error && (
        <a
          href={`/runs/${runId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-muted-foreground underline hover:text-foreground"
        >
          Open run #{runId} ↗
        </a>
      )}
    </div>
  );
}

interface FirstSseEvent {
  /** The first parsed `data:` frame, or null if the stream ended empty. */
  event: { type?: string; error?: string } | null;
  /** Drains the rest of the stream (keeping the turn alive) without aborting. */
  drain: () => Promise<void>;
}

// Read just the first SSE `data:` frame so the caller can react to an immediate
// `error` without waiting for the whole turn. `drain` keeps reading the rest in
// the background — never abort on success, as that cancels the agent's turn.
async function readFirstSseEvent(body: ReadableStream<Uint8Array>): Promise<FirstSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: { type?: string; error?: string } | null = null;
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          event = JSON.parse(line.slice(6)) as { type?: string; error?: string };
        } catch {
          continue;
        }
        break outer;
      }
    }
  }
  const drain = async () => {
    try {
      while (!(await reader.read()).done) {
        /* discard remaining frames */
      }
    } catch {
      /* stream ended / released */
    }
  };
  return { event, drain };
}
