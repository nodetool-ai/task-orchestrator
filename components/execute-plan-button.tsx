"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PlayCircle, X } from "lucide-react";
import { cn, describe } from "@/lib/utils";
import { ModelPicker, type ModelOption } from "@/components/chat/model-picker";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

interface Props {
  planId: string;
  /** Number of tasks not yet done/cancelled — used to size the default budget. */
  openTaskCount: number;
  className?: string;
}

/**
 * Execute-plan button on the plan page. Kicks off a single long-running plan
 * executor agent (goal=<execute>) that implements every open task, reviews each
 * PR, auto-fixes on request_changes, and squash-merges approved PRs into the
 * default branch. POSTs to /api/runs and redirects to /runs/[id], where the
 * executor's progress (and its spawned child runs) stream live.
 *
 * The executor is the budget-tree root: child implement/review runs share the
 * cap budget × TASK_ORCH_TREE_BUDGET_MULT (default ×3), so the default maxUsd
 * is sized to cover all open tasks (~$25 each).
 */
export function ExecutePlanButton({ planId, openTaskCount, className }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [instructions, setInstructions] = useState("");
  const [maxUsd, setMaxUsd] = useState(Math.max(openTaskCount, 1) * 25);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setInstructions("");
    setMaxUsd(Math.max(openTaskCount, 1) * 25);
    fetch("/api/providers")
      .then((res) => res.json())
      .then((data: { providers: { id: string; models: { id: string; name: string }[] }[] }) => {
        const flat: ModelOption[] = [];
        for (const provider of data.providers ?? []) {
          for (const m of provider.models ?? []) {
            flat.push({ id: m.id, name: m.name, provider: provider.id });
          }
        }
        setModelOptions(flat);
        const qualified = flat.map((o) => `${o.provider}/${o.id}`);
        setModel((cur) => (qualified.includes(cur) ? cur : qualified[0] ?? cur));
      })
      .catch(() => {});
  }, [open, openTaskCount]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const submit = () => {
    setError(null);
    if (!(maxUsd > 0)) {
      setError("Budget must be greater than 0.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            goal: "<execute>",
            planId,
            personaId: "executor",
            model,
            initialPrompt: instructions.trim() || undefined,
            budget: { maxUsd, maxTurns: 200 },
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        const run = (await res.json()) as { id: number };
        router.push(`/runs/${run.id}`);
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={openTaskCount === 0}
        title={openTaskCount === 0 ? "No open tasks to execute" : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground text-background px-3 py-1.5 text-xs font-medium",
          "hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed",
          className
        )}
      >
        <PlayCircle className="size-3.5" />
        Execute plan
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-border bg-card shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-label="Execute plan"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
              <div className="flex items-center gap-2">
                <PlayCircle className="size-4 text-foreground" />
                <h2 className="text-sm font-semibold tracking-tight">Execute plan</h2>
                <span className="font-mono text-[11px] text-muted-foreground">{planId}</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="px-5 py-4 space-y-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Launches a plan-executor agent that implements all {openTaskCount} open
                task{openTaskCount === 1 ? "" : "s"} (running independent tasks in parallel),
                reviews each PR, auto-fixes on requested changes, and squash-merges approved
                PRs into the default branch.
              </p>

              <div className="grid grid-cols-2 gap-4 text-xs">
                <Field label="Model">
                  <ModelPicker
                    value={model}
                    options={modelOptions}
                    onChange={setModel}
                    disabled={pending}
                  />
                </Field>
                <Field label="Budget (max USD)">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={maxUsd}
                    onChange={(e) => setMaxUsd(Number(e.target.value))}
                    disabled={pending}
                    className="w-24 rounded border border-border/60 bg-background px-2 py-0.5 font-mono text-[11px] tabular-nums outline-none focus:border-foreground/40"
                  />
                </Field>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground/80">
                The executor is the budget root; child runs share a cap of budget × 3. Sized
                to ~$25 per open task by default — raise it for larger plans.
              </p>

              <div>
                <label
                  htmlFor="execute-instructions"
                  className="block text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1"
                >
                  Instructions{" "}
                  <span className="normal-case tracking-normal text-muted-foreground/70">
                    (optional — appended to the executor&apos;s prompt)
                  </span>
                </label>
                <textarea
                  id="execute-instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  disabled={pending}
                  rows={4}
                  placeholder="Steer the executor: priorities, constraints, what to skip, branch/PR conventions…"
                  className={cn(
                    "w-full resize-y rounded-md border border-border bg-background px-3 py-2",
                    "text-xs leading-relaxed text-foreground/90",
                    "focus:outline-none focus:ring-1 focus:ring-foreground/40 disabled:opacity-50"
                  )}
                />
              </div>

              {error && <p className="text-xs text-state-blocked">{error}</p>}
            </div>

            <footer className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className={cn(
                  "rounded-md border border-border bg-transparent px-3 py-1.5 text-xs font-medium",
                  "hover:bg-muted transition-colors disabled:opacity-40"
                )}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={pending || !(maxUsd > 0)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground text-background px-3 py-1.5 text-xs font-medium",
                  "hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                )}
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <PlayCircle className="size-3.5" />
                )}
                Start execution
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">{label}</div>
      <div className="mt-0.5 text-foreground/90">{children}</div>
    </div>
  );
}
