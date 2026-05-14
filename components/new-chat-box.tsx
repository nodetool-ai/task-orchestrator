"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Loader2 } from "lucide-react";

import {
  PersonaPicker,
  type PersonaOption,
} from "@/components/pickers/persona-picker";

// Re-export so existing server-component callers can keep importing the
// PersonaOption type from this module.
export type { PersonaOption };

interface RepoOption {
  id: string;
  name: string;
}

interface Props {
  personas: PersonaOption[];
  repositories: RepoOption[];
}

/**
 * Top-level "new chat" composer for the /chat page. Creates a global
 * (no taskId) `<chat>` run scoped to the chosen repo, posts the first
 * message, then navigates into the new run.
 */
export function NewChatBox({ personas, repositories }: Props) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? "implementor");
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
          personaId,
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
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <PersonaPicker
          personas={personas}
          value={personaId}
          onChange={setPersonaId}
          size="compact"
        />
        {repositories.length > 0 && (
          <select
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            className="rounded-sm border border-border/60 bg-background px-2 py-0.5 outline-none focus:border-foreground/40"
            title="Repository"
          >
            <option value="">No repo</option>
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card/40 px-3 py-2 focus-within:border-foreground/30 transition-colors">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={onInput}
          onKeyDown={onKeyDown}
          placeholder="Start a new chat with the agent…"
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
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
