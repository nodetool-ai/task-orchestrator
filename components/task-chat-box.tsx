"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PersonaPicker,
  type PersonaOption,
} from "@/components/pickers/persona-picker";
import { ModelPicker, type ModelOption } from "@/components/chat/model-picker";
import { ThinkingLevelPicker, type ThinkingLevel } from "@/components/pickers/thinking-level-picker";

export type { PersonaOption };

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

interface Props {
  taskId: string;
  /** Resolved repo for the task (null when the task has no repo attached). */
  repoId: string | null;
  /**
   * Pre-rendered chat-prompt prefix (task title/body/criteria/notes/PR).
   * Prepended to the user's text before being sent as the first message.
   */
  promptPrefix: string;
  /** Available personas for the picker (passed from the server page). */
  personas?: PersonaOption[];
  className?: string;
}

/**
 * Free-form chat composer pinned to the task page. Sending creates a
 * task-scoped `<chat>` run (toolsProfile = orchestrator,repo_write, cwd from
 * the task's repo) and POSTs the user's message — prepended with the task
 * context block — as the run's first message. The new run opens in a new tab
 * (side-panel semantics) so the task page stays put.
 */
export function TaskChatBox({ taskId, repoId, promptPrefix, personas = [], className }: Props) {
  const [input, setInput] = useState("");
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? "implementor");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [reasoning, setReasoning] = useState<ThinkingLevel | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
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
  }, []);

  // Auto-grow the textarea like the run-view composer.
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

  async function submit() {
    const text = input.trim();
    if (!text || pending) return;
    setError(null);
    setPending(true);
    try {
      // 1. Open-or-create the task's single attached run (deferred — no implement
      //    seed; this message is its first turn). The pickers are honored only
      //    when the run is first created.
      const createRes = await fetch(`/api/tasks/${taskId}/attached-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed: false, personaId, model, thinkingLevel: reasoning }),
      });
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${createRes.status}`);
        return;
      }
      const { runId, created } = (await createRes.json()) as {
        runId: number;
        created: boolean;
      };

      // 2. Send the user's message. Prefix the task context only on the first
      //    message of a fresh run — an existing session already has it.
      //    Fire-and-forget; the run page surfaces any error and streams the reply.
      const messageText = created ? `${promptPrefix}\n\n---\n\n${text}` : text;
      void fetch(`/api/runs/${runId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: messageText }),
      }).catch(() => {
        // The /runs/[id] page surfaces errors; nothing useful to do here.
      });

      // 3. Side-panel semantics → open the attached run in a new tab.
      window.open(`/runs/${runId}`, "_blank", "noopener,noreferrer");

      // Reset input on success.
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
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageCircle className="size-3.5" />
          <span>Ask the agent about this task — opens its attached run.</span>
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
        </div>
      </div>
      <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card/40 px-3 py-2 focus-within:border-foreground/30 transition-colors">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          placeholder="What about this task?"
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
      {error && <p className="text-xs text-state-blocked">{error}</p>}
    </div>
  );
}
