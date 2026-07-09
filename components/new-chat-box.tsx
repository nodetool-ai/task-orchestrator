"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { type PersonaOption } from "@/components/pickers/persona-picker";
import {
  RepositoryPicker,
  type RepositoryOption,
} from "@/components/pickers/repository-picker";
import { ModelPicker } from "@/components/chat/model-picker";
import { ThinkingLevelPicker, type ThinkingLevel } from "@/components/pickers/thinking-level-picker";
import { stashPendingMessage } from "@/lib/pending-first-message";
import {
  ComposerSendButton,
  ComposerTextarea,
} from "@/components/chat/composer-parts";
import { ErrorText } from "@/components/ui/error-text";
import { useModelOptions } from "@/components/chat/use-model-options";

// Re-export so existing server-component callers can keep importing the
// PersonaOption type from this module.
export type { PersonaOption };

type RepoOption = RepositoryOption;

interface Props {
  defaultModel: string;
  repositories: RepoOption[];
}

/**
 * Top-level "new chat" composer for the /chat page. Creates a global
 * (no taskId) `<chat>` run scoped to the chosen repo, posts the first
 * message, then navigates into the new run.
 */
export function NewChatBox({ defaultModel, repositories }: Props) {
  const router = useRouter();
  const [input, setInput] = useState("");
  // Chat runs the lightweight in-process loop (the pi backend's 'postgres'
  // context mode, lib/agent-backend/postgres-turn.ts) — always pi, never the
  // Claude backend. Lock the picker to pi so no engine selector renders and
  // only pi-provided models are offered.
  const { model, setModel, modelOptions } = useModelOptions(defaultModel, true, "pi");
  const [reasoning, setReasoning] = useState<ThinkingLevel | null>(null);
  const [repoId, setRepoId] = useState<string>(repositories[0]?.id ?? "");
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
          repoId: repoId || null,
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

      // Hand the first message to the conversation view rather than posting it
      // here. RunView is the authoritative streamer for a chat turn — if we
      // POST and immediately navigate, that turn's SSE stream is discarded and
      // the message never renders (the read-only /events bus doesn't carry the
      // user message). RunView picks this up on mount and sends it through its
      // normal optimistic + streaming path.
      stashPendingMessage(run.id, text);

      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="rounded-2xl border border-border/60 bg-card/40 focus-within:border-foreground/30 transition-colors">
        <ComposerTextarea
          ref={textareaRef}
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          placeholder="Start a new chat with the agent…"
          disabled={pending}
          className="w-full px-3 pb-1 pt-3"
        />
        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
          <ModelPicker
            value={model}
            options={modelOptions}
            onChange={setModel}
            disabled={pending}
          />
          <ThinkingLevelPicker
            value={reasoning}
            onChange={setReasoning}
            className="rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted/40 focus:border-foreground/30 focus:outline-none disabled:opacity-50"
          />
          {repositories.length > 0 && (
            <RepositoryPicker
              repositories={repositories}
              value={repoId}
              onChange={setRepoId}
              disabled={pending}
              className="rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] font-mono text-foreground transition-colors hover:bg-muted/40 focus:border-foreground/30 focus:outline-none disabled:opacity-50"
            />
          )}
          <div className="flex-1" />
          <ComposerSendButton pending={pending} disabled={!input.trim()} onClick={submit} />
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
