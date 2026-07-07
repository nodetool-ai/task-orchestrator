"use client";

import { Spinner } from "@/components/ui/spinner";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { cn, describe } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { BackendPicker } from "@/components/pickers/backend-picker";
import { ModelPicker } from "@/components/chat/model-picker";
import { DEFAULT_CHAT_MODEL, useModelOptions } from "@/components/chat/use-model-options";

interface Props {
  taskId: string;
  /** Whether the task already has a usable attached run (server-resolved). */
  hasAttachedRun: boolean;
  className?: string;
}

/**
 * One-click entry to a task's single attached run. Opens it if it exists,
 * otherwise creates it (seeded with the implement prompt) and navigates to the
 * streaming /runs/[id] view. Replaces the old Run-agent / Run-review buttons.
 */
export function TaskAgentButton({ taskId, hasAttachedRun, className }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { model, setModel, modelOptions, backend, setBackend, backendOptions } =
    useModelOptions(DEFAULT_CHAT_MODEL, open && !hasAttachedRun);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/attached-run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seed: true, model, backend }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        const { runId } = (await res.json()) as { runId: number };
        setOpen(false);
        router.push(`/runs/${runId}`);
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  const go = () => {
    if (hasAttachedRun) {
      submit();
    } else {
      setError(null);
      setOpen(true);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={go}
        disabled={pending}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 text-xs font-medium",
          "hover:bg-muted transition-colors disabled:opacity-60",
          className
        )}
      >
        {pending ? (
          <Spinner className="size-3.5" />
        ) : (
          <Sparkles className="size-3.5 text-state-review" />
        )}
        {hasAttachedRun ? "Open agent" : "Start agent"}
      </button>
      {error && <span className="text-[11px] text-destructive">{error}</span>}
      {open && !hasAttachedRun && (
        <Modal onClose={() => setOpen(false)} ariaLabel="Start agent" className="max-w-md">
          <header className="flex items-center gap-2 border-b border-border/60 px-5 py-3">
            <Sparkles className="size-4 text-state-review" />
            <h2 className="text-sm font-semibold tracking-tight">Start agent</h2>
            <span className="font-mono text-[11px] text-muted-foreground">{taskId}</span>
          </header>

          <div className="px-5 py-4 space-y-4 text-xs">
            <Field label="Model">
              <div className="flex items-center gap-2">
                <BackendPicker
                  value={backend}
                  options={backendOptions}
                  onChange={setBackend}
                  disabled={pending}
                />
                <ModelPicker
                  value={model}
                  options={modelOptions}
                  onChange={setModel}
                  disabled={pending}
                />
              </div>
            </Field>
            <ErrorText>{error}</ErrorText>
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? <Spinner /> : <Sparkles className="size-3.5" />}
              Start
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
