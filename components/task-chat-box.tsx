"use client";

import { useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PersonaPicker,
  type PersonaOption,
} from "@/components/pickers/persona-picker";
import { ModelPicker } from "@/components/chat/model-picker";
import { ThinkingLevelPicker, type ThinkingLevel } from "@/components/pickers/thinking-level-picker";
import { ErrorText } from "@/components/ui/error-text";
import {
  ComposerInputShell,
  ComposerSendButton,
  ComposerTextarea,
} from "@/components/chat/composer-parts";
import { useModelOptions } from "@/components/chat/use-model-options";

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
  // Task-scoped chats run on the lightweight pi loop — pi only, no engine picker.
  const { model, setModel, modelOptions } = useModelOptions(undefined, true, "pi");
  const [reasoning, setReasoning] = useState<ThinkingLevel | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the browser blocks the run tab we can't recover the popup handle, so
  // surface a manual link instead of leaving the sent message invisible.
  const [openRunId, setOpenRunId] = useState<number | null>(null);
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
    setOpenRunId(null);
    setPending(true);

    // Open the run tab *synchronously* — inside the click/keydown gesture and
    // before any await — so Safari's popup blocker (which only allows
    // window.open during a user gesture) doesn't kill it after our fetches.
    // We can't pass `noopener` here or the handle comes back null; the tab is
    // same-origin so navigating it after the awaits is safe. If the browser
    // still blocked it we fall back to an inline "Open run" link.
    const popup = window.open("", "_blank");

    try {
      // 1. Open-or-create the task's single attached run (deferred — no implement
      //    seed; this message is its first turn). The pickers are honored only
      //    when the run is first created.
      const createRes = await fetch(`/api/tasks/${taskId}/attached-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed: false, personaId, model, backend: "pi", thinkingLevel: reasoning }),
      });
      if (!createRes.ok) {
        popup?.close();
        const body = await createRes.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${createRes.status}`);
        return;
      }
      const { runId, created } = (await createRes.json()) as {
        runId: number;
        created: boolean;
      };

      // 2. Send the user's message. Prefix the task context only on the first
      //    message of a fresh run — an existing session already has it. The
      //    POST streams the turn back; read the first SSE frame so an immediate
      //    `error` (e.g. the attached run is mid-turn → "already in flight")
      //    surfaces here instead of being dropped on an unread 200 stream.
      const messageText = created ? `${promptPrefix}\n\n---\n\n${text}` : text;
      const msgRes = await fetch(`/api/runs/${runId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: messageText }),
      });
      if (!msgRes.ok || !msgRes.body) {
        popup?.close();
        setError(`HTTP ${msgRes.status}`);
        return;
      }
      const { event, drain } = await readFirstSseEvent(msgRes.body);
      // Keep draining the rest in the background so the turn isn't cancelled —
      // aborting the POST stream would abort the agent's turn. The attached run
      // (opened in the new tab) renders the reply via its own /events feed.
      void drain();
      if (event?.type === "error") {
        popup?.close();
        setError(event.error ?? "The agent is busy — try again in a moment.");
        return; // do not clear the input or navigate as if it succeeded
      }

      // 3. Side-panel semantics → reveal the attached run in the new tab, or
      //    fall back to an inline link when the popup was blocked.
      if (popup) {
        popup.location.href = `/runs/${runId}`;
      } else {
        setOpenRunId(runId);
      }

      // Reset input on success.
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <MessageCircle className="size-3.5 shrink-0" />
          <span>Ask the agent about this task — opens its attached run.</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
      <ComposerInputShell>
        <ComposerTextarea
          ref={textareaRef}
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          placeholder="What about this task?"
          disabled={pending}
        />
        <ComposerSendButton pending={pending} disabled={!input.trim()} onClick={submit} />
      </ComposerInputShell>
      <ErrorText>{error}</ErrorText>
      {openRunId != null && (
        <p className="text-xs text-muted-foreground">
          Message sent.{" "}
          <a
            href={`/runs/${openRunId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            Open run #{openRunId} ↗
          </a>
        </p>
      )}
    </div>
  );
}

interface FirstSseEvent {
  /** The first parsed `data:` frame, or null if the stream ended empty. */
  event: { type?: string; error?: string } | null;
  /** Drains the rest of the stream (keeping the turn alive) without aborting. */
  drain: () => Promise<void>;
}

// Read just the first SSE `data:` frame from a POST /messages response so the
// caller can react to an immediate `error` without waiting for the whole turn.
// The returned `drain` keeps reading the remainder in the background — never
// abort the stream on success, as that cancels the agent's turn.
async function readFirstSseEvent(body: ReadableStream<Uint8Array>): Promise<FirstSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: { type?: string; error?: string } | null = null;
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          event = JSON.parse(line.slice(6)) as { type?: string; error?: string };
        } catch {
          continue;
        }
        break outer;
      }
    }
  }
  const drain = async () => {
    try {
      while (!(await reader.read()).done) {
        /* discard remaining frames */
      }
    } catch {
      /* stream ended / released */
    }
  };
  return { event, drain };
}
