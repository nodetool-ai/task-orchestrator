"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface WorkerLogResponse {
  source: "live" | "stored" | null;
  log: string;
  exitCode: number | null;
  error?: string;
}

// The raw output of a run's worker (a local docker container's logs, or a Fly
// worker's runner.log) — the place to look when a run fails without anything
// useful in the transcript (OOM kill, crash before the agent started, git/auth
// trouble). "live" = read from the running container just now; "stored" = the
// tail captured/flushed onto the run row (at container death, or during/at the
// end of a Fly run).
export function WorkerLogPanel({ runId }: { runId: number }) {
  const [data, setData] = useState<WorkerLogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/worker-log`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as WorkerLogResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-semibold text-foreground">Worker log</span>
        {data?.source && (
          <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono">
            {data.source === "live" ? "live container" : "captured at exit"}
          </span>
        )}
        {data?.exitCode != null && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono",
              data.exitCode === 0
                ? "bg-muted/60"
                : "bg-state-blocked/10 text-state-blocked"
            )}
          >
            exit {data.exitCode}
            {data.exitCode === 137 ? " (killed — OOM?)" : ""}
          </span>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          refresh
        </button>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-5 text-foreground/90">
        {error ? (
          <span className="text-state-blocked">failed to load: {error}</span>
        ) : loading && !data ? (
          <span className="text-muted-foreground/60">loading…</span>
        ) : data && data.log ? (
          data.log
        ) : (
          <span className="text-muted-foreground/60">
            No worker log for this run — it either predates log capture or its
            worker never produced any output.
          </span>
        )}
      </pre>
    </div>
  );
}
