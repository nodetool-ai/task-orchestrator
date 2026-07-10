"use client";

import { useState } from "react";
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  Eye,
  GitPullRequest,
  ListTodo,
  MessageSquare,
  ShieldAlert,
  Wallet,
  Workflow,
  Zap,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";

// One envelope of a persisted `event_digest` frame (lib/inbox.ts §2), after
// the JSON hop — dates are ISO strings. Rendered defensively: digest frames
// are written by the runner, but an old or malformed frame must degrade to
// "unknown event", never crash the timeline.
export interface DigestEnvelope {
  event_id: number;
  type: string;
  occurred_at: string;
  audience: "owner" | "supervisor";
  source: { kind: string; id: string | null };
  attempt: number | null;
  correlation_id: string | null;
  causation_event_id: number | null;
  bubbled_from: number | null;
  payload: unknown;
}

// Mirrors CONTROL_TYPES in lib/inbox.ts (not imported — that module pulls in
// the db singleton, which must not reach the client bundle).
const CONTROL_TYPES = new Set(["run.cancel_requested", "run.budget_exhausted"]);

/**
 * Per-type counts for the folded summary line, most frequent first (ties by
 * first appearance). Pure; exported for unit tests.
 */
export function summarizeDigestTypes(rows: Array<{ type: string }>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// The "woken by: …" card (docs/agent-events.md §11): a digest frame persisted
// at turn start is exactly what the agent saw, so the timeline renders the
// same data — owner events (the ones the run must act on) first, then the
// informational supervisor section. Every wake is explainable in place.
//
// FOLDED by default: a webhook storm can wake a run with dozens of events, and
// one row per event turns the timeline into noise. The card collapses to a
// single line — "Woken by N events" plus per-type counts — and expands on
// click to the full per-event rows. A single-event wake needs no fold and
// renders expanded.
export function EventDigestCard({
  when,
  events,
}: {
  when: Date;
  events: DigestEnvelope[];
}) {
  const rows = (Array.isArray(events) ? events : []).filter(
    (e): e is DigestEnvelope => !!e && typeof e === "object" && typeof e.type === "string"
  );
  const foldable = rows.length > 1;
  const [expanded, setExpanded] = useState(false);
  const open = !foldable || expanded;
  const owner = rows.filter((e) => e.audience !== "supervisor");
  const supervisor = rows.filter((e) => e.audience === "supervisor");
  const typeCounts = summarizeDigestTypes(rows);
  // Old/malformed frames may lack event_id; fall back to the list position so
  // React keys stay unique and stable within a render.
  const keyFor = (e: DigestEnvelope, i: number) =>
    typeof e.event_id === "number" ? `e-${e.event_id}` : `i-${i}`;

  const header = (
    <>
      <Zap className="size-3.5 shrink-0 text-state-review" />
      <span className="shrink-0 font-semibold text-foreground">
        Woken by {rows.length} event{rows.length === 1 ? "" : "s"}
      </span>
      {!open && (
        <span className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">
          {typeCounts.map(([type, n]) => (
            <span
              key={type}
              className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {type}
              {n > 1 && <span className="tabular-nums text-muted-foreground/70">×{n}</span>}
            </span>
          ))}
        </span>
      )}
      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/80">
        {formatDateTime(when)}
      </span>
    </>
  );

  return (
    <div className="mx-4 my-2 rounded-md border border-state-review/30 bg-card/40 text-[11px]">
      {foldable ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:bg-muted/30 ${
            open ? "border-b border-border/60" : ""
          }`}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/70" />
          )}
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-muted-foreground">
          {header}
        </div>
      )}
      {open && owner.length > 0 && (
        <div className="divide-y divide-border/40">
          {owner.map((e, i) => (
            <EnvelopeRow key={keyFor(e, i)} envelope={e} />
          ))}
        </div>
      )}
      {open && supervisor.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 border-t border-border/60 bg-muted/30 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Eye className="size-3" />
            For awareness — informational; the owning run acts
          </div>
          <div className="divide-y divide-border/40">
            {supervisor.map((e, i) => (
              <EnvelopeRow key={keyFor(e, i)} envelope={e} />
            ))}
          </div>
        </div>
      )}
      {rows.length === 0 && (
        <div className="px-3 py-1.5 text-muted-foreground/70">
          (empty or unreadable digest frame)
        </div>
      )}
    </div>
  );
}

function EnvelopeRow({ envelope: e }: { envelope: DigestEnvelope }) {
  const Icon = iconForType(e.type);
  const payloadJson = safeStringify(e.payload);
  return (
    <div className="flex items-start gap-2 px-3 py-1.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <code className="font-mono text-foreground">{e.type}</code>
          {typeof e.event_id === "number" && (
            <span className="font-mono text-[10px] text-muted-foreground/80 tabular-nums">
              #{e.event_id}
            </span>
          )}
          {CONTROL_TYPES.has(e.type) && (
            <span className="inline-flex items-center gap-1 rounded bg-state-blocked/10 px-1.5 py-0.5 text-[10px] text-state-blocked">
              <ShieldAlert className="size-3" /> platform-enforced
            </span>
          )}
          <SourceChip e={e} />
          {e.attempt != null && (
            <span className="text-muted-foreground">attempt {e.attempt}</span>
          )}
          {e.bubbled_from != null && (
            <span className="text-muted-foreground">
              bubbled from run #{e.bubbled_from}
            </span>
          )}
          {e.correlation_id && (
            <code className="font-mono text-[10px] text-muted-foreground/80">
              {e.correlation_id}
            </code>
          )}
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {e.occurred_at ? formatDateTime(new Date(e.occurred_at)) : ""}
          </span>
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
    </div>
  );
}

function SourceChip({ e }: { e: DigestEnvelope }) {
  const kind = e.source?.kind ?? "?";
  const id = e.source?.id ?? null;
  // Child-run sources link to the child so a `child.result` is one click from
  // the run that produced it — the causal chain stays navigable.
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

function iconForType(type: string) {
  if (type.startsWith("child.")) return Workflow;
  if (type.startsWith("gh.")) return GitPullRequest;
  if (type.startsWith("timer.")) return AlarmClock;
  if (type.startsWith("budget.") || type === "run.budget_exhausted") return Wallet;
  if (type.startsWith("task.") || type.startsWith("plan.")) return ListTodo;
  return MessageSquare;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}
