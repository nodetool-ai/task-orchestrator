"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PersonaPicker,
  type PersonaOption,
} from "@/components/pickers/persona-picker";
import { ModelPicker, type ModelOption } from "@/components/chat/model-picker";

// Mirrors the chat composer's default; snapped to a backend-offered model
// once /api/providers resolves so "Start run" always sends something valid.
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

interface Props {
  taskId: string;
  hasActive: boolean;
  /** Pre-rendered implement prompt; user can edit before submitting. */
  initialPrompt: string;
  /** Budget cap (USD) shown next to the textarea. */
  budgetMaxUsd: number;
  /** Available personas for the picker (fetched server-side). */
  personas?: PersonaOption[];
  className?: string;
}

/**
 * Run-agent button on the task page. Opens a modal showing the implement
 * template prompt (editable) plus the budget cap, then POSTs to /api/runs
 * with the implement template (`goal=<implement>`, `tools=orchestrator,repo_write`,
 * `cwd=worktree`) and redirects the user to /runs/[id] where the conversation
 * is already streaming.
 */
export function RunAgentButton({
  taskId,
  hasActive,
  initialPrompt,
  budgetMaxUsd,
  personas = [],
  className,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? "implementor");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-sync local state whenever the modal is (re-)opened so edits from a
  // previous open don't linger and stale prompts from the task page don't
  // overwrite the user's draft mid-typing.
  useEffect(() => {
    if (open) {
      setPrompt(initialPrompt);
      setPersonaId(personas[0]?.id ?? "implementor");
      setError(null);
      // Fetch the active backend's model catalog and snap the selection to a
      // model it actually offers (same pattern as the chat composer).
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
        .catch(() => {
          // Leave options empty; ModelPicker shows the fallback entry.
        });
      // Focus the textarea on open; small delay to let the dialog mount.
      const id = window.setTimeout(() => textareaRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
  }, [open, initialPrompt]);

  // ESC to close.
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
    const text = prompt.trim();
    if (!text) {
      setError("Prompt cannot be empty.");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "<implement>",
          toolsProfile: "orchestrator,repo_write",
          cwdStrategy: "worktree",
          taskId,
          initialPrompt: text,
          personaId,
          model,
          budget: { maxUsd: budgetMaxUsd },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const run = (await res.json()) as { id: number };
      router.push(`/runs/${run.id}`);
    });
  };

  return (
    <>
      <div className={cn("flex flex-col items-end gap-1", className)}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={hasActive}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground text-background px-3 py-1.5 text-xs font-medium",
            "hover:opacity-90 transition-opacity",
            "disabled:opacity-40 disabled:cursor-not-allowed"
          )}
        >
          <Sparkles className="size-3.5" />
          {hasActive ? "Agent running" : "Run agent: Implement"}
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-lg border border-border bg-card shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-label="Run agent: Implement"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-foreground" />
                <h2 className="text-sm font-semibold tracking-tight">
                  Run agent: Implement
                </h2>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {taskId}
                </span>
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

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-xs">
                <Field label="Tools profile">
                  <code className="font-mono">orchestrator, repo_write</code>
                </Field>
                <Field label="Cwd strategy">
                  <code className="font-mono">worktree</code>
                </Field>
                <Field label="Budget (max USD)">
                  <code className="font-mono tabular-nums">${budgetMaxUsd.toFixed(2)}</code>
                </Field>
                <Field label="Goal">
                  <code className="font-mono">&lt;implement&gt;</code>
                </Field>
                {personas.length > 0 && (
                  <Field label="Persona">
                    <PersonaPicker
                      personas={personas}
                      value={personaId}
                      onChange={setPersonaId}
                      className="rounded border border-border/60 bg-background px-2 py-0.5 font-mono text-[11px] outline-none focus:border-foreground/40"
                    />
                  </Field>
                )}
                <Field label="Model">
                  <ModelPicker
                    value={model}
                    options={modelOptions}
                    onChange={setModel}
                    disabled={pending}
                  />
                </Field>
              </div>

              <div>
                <label
                  htmlFor="implement-prompt"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Prompt
                  <span className="ml-2 text-[10px] text-muted-foreground/80">
                    edit before sending if you like
                  </span>
                </label>
                <textarea
                  id="implement-prompt"
                  ref={textareaRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={18}
                  className={cn(
                    "w-full resize-y rounded-md border border-border bg-background px-3 py-2",
                    "font-mono text-[11px] leading-relaxed text-foreground/90",
                    "focus:outline-none focus:ring-1 focus:ring-foreground/40"
                  )}
                  spellCheck={false}
                />
              </div>

              {error && (
                <p className="text-xs text-state-blocked">{error}</p>
              )}
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
                disabled={pending || !prompt.trim()}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground text-background px-3 py-1.5 text-xs font-medium",
                  "hover:opacity-90 transition-opacity",
                  "disabled:opacity-40 disabled:cursor-not-allowed"
                )}
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                Start run
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
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </div>
      <div className="mt-0.5 text-foreground/90">{children}</div>
    </div>
  );
}
