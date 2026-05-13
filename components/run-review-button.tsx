"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitPullRequest, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  taskId: string;
  /** Pre-rendered review prompt; user can edit before submitting. */
  initialPrompt: string;
  /** PR url the review will run against (head ref → worktree). */
  prUrl: string;
  /** Budget cap (USD) shown next to the textarea. */
  budgetMaxUsd: number;
  className?: string;
}

/**
 * Run-review-agent button on the task page. Mirrors RunAgentButton (T-0052)
 * but kicks off a `<review>` run using the `gh_pr` profile and the
 * `worktree_at_pr` cwd strategy. POSTs to /api/runs and redirects the user
 * to /runs/[id] with the conversation already streaming.
 */
export function RunReviewButton({
  taskId,
  initialPrompt,
  prUrl,
  budgetMaxUsd,
  className,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setPrompt(initialPrompt);
      setError(null);
      const id = window.setTimeout(() => textareaRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
  }, [open, initialPrompt]);

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
          goal: "<review>",
          toolsProfile: "orchestrator,repo_read,gh_pr",
          cwdStrategy: "worktree_at_pr",
          taskId,
          prUrl,
          initialPrompt: text,
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 text-xs font-medium",
          "hover:bg-muted transition-colors",
          className
        )}
      >
        <GitPullRequest className="size-3.5 text-state-review" />
        Run agent: Review
      </button>

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
            aria-label="Run agent: Review"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
              <div className="flex items-center gap-2">
                <GitPullRequest className="size-4 text-state-review" />
                <h2 className="text-sm font-semibold tracking-tight">
                  Run agent: Review
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
                  <code className="font-mono">orchestrator, repo_read, gh_pr</code>
                </Field>
                <Field label="Cwd strategy">
                  <code className="font-mono">worktree_at_pr</code>
                </Field>
                <Field label="Budget (max USD)">
                  <code className="font-mono tabular-nums">
                    ${budgetMaxUsd.toFixed(2)}
                  </code>
                </Field>
                <Field label="Goal">
                  <code className="font-mono">&lt;review&gt;</code>
                </Field>
                <Field label="Pull request" className="col-span-2">
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-foreground hover:underline decoration-dotted break-all"
                  >
                    {prUrl}
                  </a>
                </Field>
              </div>

              <div>
                <label
                  htmlFor="review-prompt"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Prompt
                  <span className="ml-2 text-[10px] text-muted-foreground/80">
                    edit before sending if you like
                  </span>
                </label>
                <textarea
                  id="review-prompt"
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
                  <GitPullRequest className="size-3.5" />
                )}
                Start review
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </div>
      <div className="mt-0.5 text-foreground/90">{children}</div>
    </div>
  );
}
