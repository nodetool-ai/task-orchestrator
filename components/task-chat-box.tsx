"use client";

import { useRef, useState } from "react";
import { ArrowUp, Loader2, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PersonaPicker,
  type PersonaOption,
} from "@/components/pickers/persona-picker";

export type { PersonaOption };

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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
      // 1. Create the chat run scoped to the task. No initialPrompt — chat
      //    runs sit idle until the first user message lands via /messages.
      const cwdStrategy = repoId ? "repo" : "none";
      const createRes = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "<chat>",
          toolsProfile: "orchestrator,repo_write",
          cwdStrategy,
          taskId,
          repoId,
          personaId,
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${createRes.status}`);
        return;
      }
      const run = (await createRes.json()) as { id: number };

      // 2. Send the user's message (prefixed with task context) as the first
      //    turn. The endpoint streams SSE back; we don't need to read it —
      //    the new tab will pick up streaming via its own SSE subscription.
      //    Fire-and-forget the post so we open the tab immediately; if the
      //    request errors out the user sees it on the run page.
      const messageText = `${promptPrefix}\n\n---\n\n${text}`;
      void fetch(`/api/runs/${run.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: messageText }),
      }).catch(() => {
        // The /runs/[id] page surfaces errors; nothing useful to do here.
      });

      // 3. Side-panel semantics → open in a new tab.
      window.open(`/runs/${run.id}`, "_blank", "noopener,noreferrer");

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
          <span>Ask the agent about this task — opens a new chat run.</span>
        </div>
        <PersonaPicker
          personas={personas}
          value={personaId}
          onChange={setPersonaId}
          size="compact"
        />
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
