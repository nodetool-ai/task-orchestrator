"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlayCircle, X } from "lucide-react";
import { describe } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
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
      <Button
        onClick={() => setOpen(true)}
        disabled={openTaskCount === 0}
        title={openTaskCount === 0 ? "No open tasks to execute" : undefined}
        className={className}
      >
        <PlayCircle className="size-3.5" />
        Execute plan
      </Button>

      {open && (
        <Modal onClose={() => setOpen(false)} ariaLabel="Execute plan">
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
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    uiSize="xs"
                    mono
                    value={maxUsd}
                    onChange={(e) => setMaxUsd(Number(e.target.value))}
                    disabled={pending}
                    className="w-24 rounded py-0.5 text-[11px] tabular-nums"
                  />
                </Field>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground/80">
                The executor is the budget root; child runs share a cap of budget × 3. Sized
                to ~$25 per open task by default — raise it for larger plans.
              </p>

              <Field
                htmlFor="execute-instructions"
                label={
                  <>
                    Instructions{" "}
                    <span className="font-normal text-muted-foreground/70">
                      (optional — appended to the executor&apos;s prompt)
                    </span>
                  </>
                }
              >
                <Textarea
                  id="execute-instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  disabled={pending}
                  rows={4}
                  placeholder="Steer the executor: priorities, constraints, what to skip, branch/PR conventions…"
                  className="resize-y text-xs leading-relaxed text-foreground/90"
                />
              </Field>

              <ErrorText>{error}</ErrorText>
            </div>

            <footer className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={pending || !(maxUsd > 0)}>
                {pending ? <Spinner /> : <PlayCircle className="size-3.5" />}
                Start execution
              </Button>
            </footer>
        </Modal>
      )}
    </>
  );
}

