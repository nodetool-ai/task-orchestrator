"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import type { SdkContentBlock } from "@/lib/sdk-message";
import { summarizeDigestTypes } from "@/components/runs/event-digest-card";
import { SystemEventRow } from "@/components/runs/system-event-row";

/** One persisted `inbox_event` mirror row, as segmented by run-view. */
export interface FoldedInboxEvent {
  key: string;
  when: Date;
  payload: Record<string, unknown>;
  content: SdkContentBlock[];
}

// A run under webhook load accumulates long stretches of per-event
// `inbox_event` mirror one-liners (one per delivery) in its timeline. This
// folds a consecutive stretch into ONE compact row — "N events · type ×n" —
// expandable to the individual rows. Single events render unfolded upstream;
// this component only receives stretches of 2+.
export function InboxEventFoldRow({ events }: { events: FoldedInboxEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const counts = summarizeDigestTypes(
    events.map((e) => ({ type: String(e.payload.event_type ?? "event") }))
  );
  const last = events[events.length - 1];
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-4 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted/30"
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 size-3 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground/70" />
        )}
        <Inbox className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="text-foreground">{events.length} events</span>{" "}
          <span className="inline-flex flex-wrap items-center gap-1 align-middle">
            {counts.map(([type, n]) => (
              <span
                key={type}
                className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]"
              >
                {type}
                {n > 1 && <span className="tabular-nums text-muted-foreground/70">×{n}</span>}
              </span>
            ))}
          </span>
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">
          {formatDateTime(last.when)}
        </span>
      </button>
      {expanded && (
        <div className="border-l border-border/40 ml-6">
          {events.map((e) => (
            <SystemEventRow
              key={e.key}
              when={e.when}
              kind="inbox_event"
              payload={e.payload}
              content={e.content}
            />
          ))}
        </div>
      )}
    </div>
  );
}
