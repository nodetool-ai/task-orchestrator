"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PersonaPicker,
  type PersonaOption,
} from "@/components/pickers/persona-picker";
import {
  RepositoryPicker,
  type RepositoryOption,
} from "@/components/pickers/repository-picker";
import { ModelPicker } from "@/components/chat/model-picker";
import { ThinkingLevelPicker, type ThinkingLevel } from "@/components/pickers/thinking-level-picker";
import { stashPendingMessage } from "@/lib/pending-first-message";
import { ErrorText } from "@/components/ui/error-text";
import { ChipButton } from "@/components/ui/chip";
import {
  ComposerInputShell,
  ComposerSendButton,
  ComposerTextarea,
} from "@/components/chat/composer-parts";
import { useModelOptions } from "@/components/chat/use-model-options";

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
 * plan), hands the user's first message — prepended with the plan context
 * block — to the run view, then navigates into the new run.
 */
export function PlanChatBox({
  planId,
  repoOptions,
  promptPrefix,
  personas = [],
  className,
}: Props) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? "implementor");
  const [repoId, setRepoId] = useState<string>(repoOptions[0]?.id ?? "");
  // Plan-scoped chats run on the lightweight pi loop — pi only, no engine picker.
  const { model, setModel, modelOptions } = useModelOptions(undefined, true, "pi");
  const [reasoning, setReasoning] = useState<ThinkingLevel | null>(null);
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
          model,
          backend: "pi",
          thinkingLevel: reasoning,
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${createRes.status}`);
        return;
      }
      const run = (await createRes.json()) as { id: number };

      // Hand the first message (with the plan context prefix) to RunView rather
      // than POSTing it here: it sends the turn through its authoritative
      // optimistic + streaming path, surfacing any error inline. router.push
      // navigates in-app — no popup blocker to fight and no duplicate run if the
      // user resends. (window.open here was blocked by Safari after the awaits.)
      const messageText = `${promptPrefix}\n\n---\n\n${text}`;
      stashPendingMessage(run.id, messageText);

      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      router.push(`/runs/${run.id}`);
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
          <ModelPicker
            value={model}
            options={modelOptions}
            onChange={setModel}
            disabled={pending}
          />
          <ThinkingLevelPicker
            value={reasoning}
            onChange={setReasoning}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs outline-none focus:border-foreground/40"
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

      <ComposerInputShell>
        <ComposerTextarea
          ref={textareaRef}
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          placeholder="Reshape the plan, add tasks, change state…"
          disabled={pending}
        />
        <ComposerSendButton pending={pending} disabled={!input.trim()} onClick={submit} />
      </ComposerInputShell>

      {!input.trim() && !pending && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {QUICK_PROMPTS.map((q) => (
            <ChipButton
              key={q.label}
              onClick={() => pickQuickPrompt(q.prompt)}
              className="bg-card/30 px-2 py-1 text-[11px]"
            >
              {q.label}
            </ChipButton>
          ))}
        </div>
      )}

      <ErrorText>{error}</ErrorText>
    </div>
  );
}
