"use client";

import {
  AlarmClock,
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

// The "woken by: …" card (docs/agent-events.md §11): a digest frame persisted
// at turn start is exactly what the agent saw, so the timeline renders the
// same data — owner events (the ones the run must act on) first, then the
// informational supervisor section. Every wake is explainable in place.
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
  const owner = rows.filter((e) => e.audience !== "supervisor");
  const supervisor = rows.filter((e) => e.audience === "supervisor");
  // Old/malformed frames may lack event_id; fall back to the list position so
  // React keys stay unique and stable within a render.
  const keyFor = (e: DigestEnvelope, i: number) =>
    typeof e.event_id === "number" ? `e-${e.event_id}` : `i-${i}`;

  return (
    <div className="mx-4 my-2 rounded-md border border-state-review/30 bg-card/40 pi-meta">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-muted-foreground">
        <Zap className="size-3.5 text-state-review" />
        <span className="font-semibold text-foreground">
          Woken by {rows.length} event{rows.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto pi-micro text-muted-foreground/80">
          {formatDateTime(when)}
        </span>
      </div>
      {owner.length > 0 && (
        <div className="divide-y divide-border/40">
          {owner.map((e, i) => (
            <EnvelopeRow key={keyFor(e, i)} envelope={e} />
          ))}
        </div>
      )}
      {supervisor.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 border-t border-border/60 bg-muted/30 px-3 py-1 pi-label text-muted-foreground">
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
          <code className="pi-mono text-foreground">{e.type}</code>
          {typeof e.event_id === "number" && (
            <span className="pi-mono pi-micro text-muted-foreground/80">
              #{e.event_id}
            </span>
          )}
          {CONTROL_TYPES.has(e.type) && (
            <span className="inline-flex items-center gap-1 rounded bg-state-blocked/10 px-1.5 py-0.5 pi-micro text-state-blocked">
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
            <code className="pi-mono pi-micro text-muted-foreground/80">
              {e.correlation_id}
            </code>
          )}
          <span className="ml-auto shrink-0 pi-micro text-muted-foreground/70">
            {e.occurred_at ? formatDateTime(new Date(e.occurred_at)) : ""}
          </span>
        </div>
        {payloadJson && payloadJson !== "{}" && (
          <details className="mt-0.5">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              payload
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted/40 px-2 py-1 pi-code text-muted-foreground">
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
