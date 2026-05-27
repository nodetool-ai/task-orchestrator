"use client";

import { useRef, useState } from "react";
import { ArrowUp, Loader2, MessageCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PersonaPicker,
  type PersonaOption,
} from "@/components/pickers/persona-picker";
import {
  RepositoryPicker,
  type RepositoryOption,
} from "@/components/pickers/repository-picker";

export type { PersonaOption };

interface Props {
  planId: string;
  /** Repositories attached to the plan; the first is the chat's default cwd. */
  repoOptions: RepositoryOption[];
  /** Pre-rendered plan-context prefix, prepended to the user's first message. */
  promptPrefix: string;
  /** Available personas for the picker. */
  personas?: PersonaOption[];
  className?: string;
}

// Quick prompts surfaced when the composer is empty. Each one names a
// concrete action the agent can take through the orchestrator MCP tools,
// so the operator learns by example what "chat with a plan" unlocks.
const QUICK_PROMPTS: Array<{ label: string; prompt: string }> = [
  {
    label: "Break the plan into tasks",
    prompt:
      "Read the plan body and split it into 3-7 well-scoped tasks. For each task: a clear title, a short body, and 2-4 acceptance criteria. Create them with `create_task`.",
  },
  {
    label: "Tighten the plan body",
    prompt:
      "Rewrite the plan body so it's sharper and easier to skim. Keep the intent intact. Apply the new version with `update_plan`.",
  },
  {
    label: "Audit the task list",
    prompt:
      "List the tasks and flag any that overlap, are vague, or are missing acceptance criteria. Fix the obvious ones in place.",
  },
  {
    label: "Reorder by dependency",
    prompt:
      "Review the open tasks and set sensible `dependencies` on each so the order of work is explicit. Use `update_task`.",
  },
];

/**
 * Free-form chat composer pinned to the plan page. Sending creates a
 * plan-scoped `<chat>` run (orchestrator tools default plan_id to this
 * plan) and POSTs the user's message — prepended with the plan context
 * block — as the run's first message. The new run opens in a new tab so
 * the plan page stays put.
 */
export function PlanChatBox({
  planId,
  repoOptions,
  promptPrefix,
  personas = [],
  className,
}: Props) {
  const [input, setInput] = useState("");
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? "implementor");
  const [repoId, setRepoId] = useState<string>(repoOptions[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function onInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function pickQuickPrompt(prompt: string) {
    setInput(prompt);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      // Allow React to commit the value before measuring.
      requestAnimationFrame(() => {
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 200) + "px";
      });
    }
  }

  async function submit() {
    const text = input.trim();
    if (!text || pending) return;
    setError(null);
    setPending(true);
    try {
      const cwdStrategy = repoId ? "repo" : "none";
      const createRes = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "<chat>",
          toolsProfile: "orchestrator,repo_write",
          cwdStrategy,
          planId,
          repoId: repoId || null,
          personaId,
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${createRes.status}`);
        return;
      }
      const run = (await createRes.json()) as { id: number };

      const messageText = `${promptPrefix}\n\n---\n\n${text}`;
      void fetch(`/api/runs/${run.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: messageText }),
      }).catch(() => {
        // The /runs/[id] page surfaces stream errors; nothing useful to do here.
      });

      window.open(`/runs/${run.id}`, "_blank", "noopener,noreferrer");

      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageCircle className="size-3.5" />
          <span>
            Ask the agent to manage this plan. Each send opens a new chat run.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <PersonaPicker
            personas={personas}
            value={personaId}
            onChange={setPersonaId}
            size="compact"
          />
          {repoOptions.length > 1 && (
            <RepositoryPicker
              repositories={repoOptions}
              value={repoId}
              onChange={setRepoId}
              size="compact"
            />
          )}
        </div>
      </div>

      <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card/40 px-3 py-2 focus-within:border-foreground/30 transition-colors">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          placeholder="Reshape the plan, add tasks, change state…"
          rows={1}
          disabled={pending}
          className="flex-1 resize-none bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none py-1.5 max-h-48 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!input.trim() || pending}
          className="inline-flex size-8 items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:opacity-40 disabled:hover:bg-foreground transition-colors"
          aria-label="Send"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </button>
      </div>

      {!input.trim() && !pending && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => pickQuickPrompt(q.prompt)}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/30 px-2 py-1 text-[11px] text-muted-foreground hover:border-foreground/30 hover:bg-card hover:text-foreground transition-colors"
            >
              <Sparkles className="size-3 text-state-review" />
              {q.label}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-state-blocked">{error}</p>}
    </div>
  );
}
