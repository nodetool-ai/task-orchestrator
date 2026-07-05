"use client";

import { useCallback, useEffect, useState } from "react";
import { AlarmClock, RefreshCw } from "lucide-react";
import { cn, formatDateTime } from "@/lib/utils";

interface InboxEventRow {
  id: number;
  type: string;
  control: boolean;
  audience: "owner" | "supervisor";
  status: "pending" | "injected" | "superseded" | "error";
  sourceKind: string;
  sourceId: string | null;
  attempt: number | null;
  correlationId: string | null;
  causationEventId: number | null;
  bubbledFrom: number | null;
  payload: unknown;
  errorReason: string | null;
  runTurnId: number | null;
  createdAt: string;
  injectedAt: string | null;
}

interface TimerRow {
  id: number;
  status: "pending" | "fired" | "cancelled";
  note: string | null;
  correlationId: string | null;
  fireAt: string;
  createdAt: string;
  firedAt: string | null;
}

interface InboxResponse {
  events: InboxEventRow[];
  timers: TimerRow[];
  error?: string;
}

const STATUS_TONE: Record<InboxEventRow["status"], string> = {
  pending: "bg-state-progress/10 text-state-progress",
  injected: "bg-muted/60 text-muted-foreground",
  superseded: "bg-muted/40 text-muted-foreground/70 line-through",
  error: "bg-state-blocked/10 text-state-blocked",
};

const TIMER_TONE: Record<TimerRow["status"], string> = {
  pending: "bg-state-progress/10 text-state-progress",
  fired: "bg-muted/60 text-muted-foreground",
  cancelled: "bg-muted/40 text-muted-foreground/70 line-through",
};

// The run's agent-event trail (docs/agent-events.md §11), fetched from
// GET /api/runs/:id/inbox. The digest cards in the timeline show what the
// agent SAW; this panel also shows what it hasn't seen yet (pending), what
// was withheld (superseded stale attempts), and what was quarantined
// (status=error + reason) — plus the run's timers. Traceability, not control:
// the panel is read-only.
type StatusFilter = "all" | InboxEventRow["status"];

const FILTERS: StatusFilter[] = ["all", "pending", "injected", "superseded", "error"];

export function InboxPanel({ runId }: { runId: number }) {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Live diagnostics: always bypass HTTP caches so "refresh" is a refresh.
      const res = await fetch(`/api/runs/${runId}/inbox`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as InboxResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const events = data?.events ?? [];
  const timers = data?.timers ?? [];
  const pending = events.filter((e) => e.status === "pending").length;
  const visibleEvents = filter === "all" ? events : events.filter((e) => e.status === filter);
  const countFor = (f: StatusFilter) =>
    f === "all" ? events.length : events.filter((e) => e.status === f).length;

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-background/60 text-[11px]">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-muted-foreground">
        <span className="font-semibold text-foreground">Agent events</span>
        <span className="tabular-nums">
          {events.length} event{events.length === 1 ? "" : "s"}
        </span>
        {pending > 0 && (
          <span className="rounded bg-state-progress/10 px-1.5 py-0.5 text-state-progress tabular-nums">
            {pending} pending
          </span>
        )}
        <div
          role="tablist"
          aria-label="Filter events by status"
          className="ml-2 inline-flex rounded border border-border/60 bg-secondary/40 p-0.5"
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                filter === f
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f}
              <span className="ml-1 tabular-nums text-muted-foreground">{countFor(f)}</span>
            </button>
          ))}
        </div>
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

      <div className="max-h-96 overflow-auto">
        {error ? (
          <p className="px-3 py-2 text-state-blocked">failed to load: {error}</p>
        ) : loading && !data ? (
          <p className="px-3 py-2 text-muted-foreground/60">loading…</p>
        ) : events.length === 0 && timers.length === 0 ? (
          <p className="px-3 py-2 text-muted-foreground/60">
            No events addressed to this run yet. Child results, GitHub activity,
            timers, and budget warnings will appear here when they arrive.
          </p>
        ) : (
          <>
            {timers.length > 0 && (
              <div className="border-b border-border/40 px-3 py-1.5">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Timers
                </div>
                <div className="space-y-0.5">
                  {timers.map((t) => (
                    <div key={t.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <AlarmClock className="size-3 text-muted-foreground" />
                      <span
                        className={cn("rounded px-1.5 py-0.5 font-mono text-[10px]", TIMER_TONE[t.status] ?? TIMER_TONE.fired)}
                      >
                        {t.status}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        fires {formatDateTime(new Date(t.fireAt))}
                      </span>
                      {t.note && <span className="text-foreground/90">{t.note}</span>}
                      {t.firedAt && (
                        <span className="text-muted-foreground/70 tabular-nums">
                          fired {formatDateTime(new Date(t.firedAt))}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="divide-y divide-border/40">
              {visibleEvents.map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
              {visibleEvents.length === 0 && events.length > 0 && (
                <p className="px-3 py-2 text-muted-foreground/60">
                  No {filter} events for this run.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EventRow({ e }: { e: InboxEventRow }) {
  const payloadJson = safeStringify(e.payload);
  return (
    <div className="px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          className={cn("rounded px-1.5 py-0.5 font-mono text-[10px]", STATUS_TONE[e.status] ?? STATUS_TONE.injected)}
        >
          {e.status}
        </span>
        <code className="font-mono text-foreground">{e.type}</code>
        <span className="font-mono text-[10px] text-muted-foreground/80 tabular-nums">#{e.id}</span>
        {e.audience === "supervisor" && (
          <span className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            supervisor copy
          </span>
        )}
        {e.control && (
          <span className="rounded bg-state-blocked/10 px-1.5 py-0.5 text-[10px] text-state-blocked">
            platform-enforced
          </span>
        )}
        <SourceChip kind={e.sourceKind} id={e.sourceId} />
        {e.attempt != null && <span className="text-muted-foreground">attempt {e.attempt}</span>}
        {e.bubbledFrom != null && (
          <span className="text-muted-foreground">bubbled from #{e.bubbledFrom}</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {formatDateTime(new Date(e.createdAt))}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground/80">
        {e.injectedAt && (
          <span className="tabular-nums">delivered {formatDateTime(new Date(e.injectedAt))}</span>
        )}
        {e.correlationId && <code className="font-mono">{e.correlationId}</code>}
        {e.causationEventId != null && <span>caused by event #{e.causationEventId}</span>}
        {e.errorReason && (
          <span className="text-state-blocked">quarantined: {e.errorReason}</span>
        )}
      </div>
      {payloadJson && payloadJson !== "{}" && (
        <details className="mt-0.5">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            payload
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground">
            {payloadJson}
          </pre>
        </details>
      )}
    </div>
  );
}

function SourceChip({ kind, id }: { kind: string; id: string | null }) {
  if (kind === "run" && id && /^\d+$/.test(id)) {
    return (
      <a
        href={`/runs/${id}`}
        className="text-muted-foreground underline decoration-dotted hover:text-foreground"
      >
        run #{id}
      </a>
    );
  }
  return (
    <span className="text-muted-foreground">
      {kind}
      {id ? ` ${id}` : ""}
    </span>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}
