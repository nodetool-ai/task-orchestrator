"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle, MessageSquare } from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import type { RunRow } from "@/lib/runs";
import type { SdkContentBlock } from "@/lib/sdk-message";
import { ErrorText } from "@/components/ui/error-text";

interface MessageLike {
  role: string;
  content: SdkContentBlock[];
}

interface ProposeSpecInput {
  title: string;
  spec_markdown: string;
  open_questions?: string[];
}

interface TaskInput {
  title: string;
  body: string;
  criteria: string[];
  dependencies?: string[];
  estimate?: string;
}

interface ProposePlanInput {
  tasks: TaskInput[];
}

function findLatestToolUse<T>(messages: MessageLike[], toolName: string): T | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "agent") continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j];
      if (block.type === "tool_use" && block.name === toolName) {
        return block.input as T;
      }
    }
  }
  return null;
}

interface Props {
  run: RunRow;
  messages: MessageLike[];
  onStageChange: (stage: string) => void;
  onRequestChanges: (hint: string) => void;
}

export function PlanningReviewCard({ run, messages, onStageChange, onRequestChanges }: Props) {
  const stage = run.planningStage ?? "gathering";

  if (stage === "spec_review") {
    return (
      <SpecReviewCard
        run={run}
        messages={messages}
        onStageChange={onStageChange}
        onRequestChanges={onRequestChanges}
      />
    );
  }

  if (stage === "plan_review") {
    return (
      <PlanReviewCard
        run={run}
        messages={messages}
        onStageChange={onStageChange}
        onRequestChanges={onRequestChanges}
      />
    );
  }

  if (stage === "done") {
    return <DoneSummary run={run} messages={messages} />;
  }

  return null;
}

// ── Spec Review Card ─────────────────────────────────────────────────────────

function SpecReviewCard({ run, messages, onStageChange, onRequestChanges }: Props) {
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = findLatestToolUse<ProposeSpecInput>(messages, "propose_spec");

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${run.id}/planning`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_spec" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { planningStage?: string };
      if (data.planningStage) onStageChange(data.planningStage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }

  if (!spec) {
    return (
      <div className="border-t border-border/60 bg-background px-4 py-4">
        <div className="mx-auto max-w-3xl text-sm text-muted-foreground">
          Waiting for spec…
        </div>
      </div>
    );
  }

  const html = renderMarkdown(spec.spec_markdown);

  return (
    <div className="border-t border-border/60 bg-background px-4 py-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Spec Draft
            </span>
            {spec.title && (
              <span className="text-sm font-medium text-foreground truncate">{spec.title}</span>
            )}
          </div>
          <div
            className="px-4 py-3 prose-tasks text-sm max-h-72 overflow-y-auto"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {spec.open_questions && spec.open_questions.length > 0 && (
            <div className="border-t border-border/60 bg-amber-50/40 dark:bg-amber-950/20 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400 mb-1.5">
                Open questions
              </p>
              <ul className="space-y-1 list-disc list-inside">
                {spec.open_questions.map((q, i) => (
                  <li key={i} className="text-xs text-amber-800 dark:text-amber-300">
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={approving}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50 transition-colors"
          >
            <CheckCircle className="size-4" />
            {approving ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => onRequestChanges("Please revise the spec: ")}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3.5 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
          >
            <MessageSquare className="size-4" />
            Request changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Plan Review Card ─────────────────────────────────────────────────────────

function PlanReviewCard({ run, messages, onStageChange, onRequestChanges }: Props) {
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = findLatestToolUse<ProposePlanInput>(messages, "propose_implementation_plan");

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${run.id}/planning`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_plan" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { planningStage?: string };
      if (data.planningStage) onStageChange(data.planningStage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }

  if (!plan) {
    return (
      <div className="border-t border-border/60 bg-background px-4 py-4">
        <div className="mx-auto max-w-3xl text-sm text-muted-foreground">
          Waiting for implementation plan…
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border/60 bg-background px-4 py-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Implementation Plan
            </span>
            <span className="text-xs text-muted-foreground">
              {plan.tasks.length} task{plan.tasks.length !== 1 ? "s" : ""}
            </span>
          </div>
          <ul className="divide-y divide-border/60 max-h-72 overflow-y-auto">
            {plan.tasks.map((task, i) => (
              <li key={i} className="px-4 py-3">
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 text-[11px] font-mono text-muted-foreground/50 shrink-0 w-4 text-right">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-sm font-medium text-foreground leading-snug">
                      {task.title}
                    </p>
                    {task.body && (
                      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                        {task.body}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/60 pt-0.5">
                      {task.criteria.length > 0 && (
                        <span>{task.criteria.length} criteria</span>
                      )}
                      {task.dependencies && task.dependencies.length > 0 && (
                        <span>deps: {task.dependencies.join(", ")}</span>
                      )}
                      {task.estimate && (
                        <span className="font-mono bg-muted/60 px-1 rounded">{task.estimate}</span>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={approving}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50 transition-colors"
          >
            <CheckCircle className="size-4" />
            {approving ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => onRequestChanges("Please revise the implementation plan: ")}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3.5 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
          >
            <MessageSquare className="size-4" />
            Request changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Done Summary ─────────────────────────────────────────────────────────────

function DoneSummary({
  run,
  messages,
}: {
  run: RunRow;
  messages: MessageLike[];
}) {
  const plan = findLatestToolUse<ProposePlanInput>(messages, "propose_implementation_plan");
  const taskCount = plan?.tasks.length ?? 0;

  return (
    <div className="border-t border-border/60 bg-muted/30 px-4 py-3 text-center text-xs text-muted-foreground">
      {run.planId ? (
        <>
          Created plan{" "}
          <Link
            href={`/plans/${run.planId}`}
            className="font-mono underline hover:text-foreground"
          >
            {run.planId}
          </Link>
          {taskCount > 0 && ` with ${taskCount} task${taskCount !== 1 ? "s" : ""}`}.
        </>
      ) : (
        "Planning complete."
      )}
    </div>
  );
}
