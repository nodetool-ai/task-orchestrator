"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Loader2 } from "lucide-react";

import { type PersonaOption } from "@/components/pickers/persona-picker";
import {
  RepositoryPicker,
  type RepositoryOption,
} from "@/components/pickers/repository-picker";
import { ModelPicker, type ModelOption } from "@/components/chat/model-picker";

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
  const [model, setModel] = useState(defaultModel);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [repoId, setRepoId] = useState<string>(repositories[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Fetch available models from /api/providers on mount.
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
      })
      .catch(() => {
        // Leave modelOptions empty; ModelPicker will show fallback entry.
      });
  }, []);

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
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${createRes.status}`);
        return;
      }
      const run = (await createRes.json()) as { id: number };

      // Send the first message; let the run page pick up streaming via SSE.
      void fetch(`/api/runs/${run.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});

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
        <textarea
          ref={textareaRef}
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          placeholder="Start a new chat with the agent…"
          rows={1}
          disabled={pending}
          className="w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none px-3 pt-3 pb-1 max-h-48 disabled:opacity-50"
        />
        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
          <ModelPicker
            value={model}
            options={modelOptions}
            onChange={setModel}
            disabled={pending}
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
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
