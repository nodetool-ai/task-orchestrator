"use client";

// The concierge homepage. One conversation, one composer, one door.
//
// Home is deliberately not a dashboard: no stat tiles, no run cards, no cost
// or token telemetry, no persona roster. The user tells the concierge an
// outcome; the concierge coordinates whichever specialists it needs. The
// operational surfaces (Plans, Tasks, Runs, Schedules, Overview) stay one
// click away in the top nav for the times someone wants the machinery.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Sparkles } from "lucide-react";

import {
  ComposerSendButton,
  ComposerTextarea,
} from "@/components/chat/composer-parts";
import { ModelPicker } from "@/components/chat/model-picker";
import { useModelOptions } from "@/components/chat/use-model-options";
import {
  RepositoryPicker,
  type RepositoryOption,
} from "@/components/pickers/repository-picker";
import {
  ThinkingLevelPicker,
  type ThinkingLevel,
} from "@/components/pickers/thinking-level-picker";
import { ErrorText } from "@/components/ui/error-text";
import { stashPendingMessage } from "@/lib/pending-first-message";
import type { ConversationCard } from "@/lib/concierge-home";
import { relativeDate } from "@/lib/utils";

/** The concierge is a single, stable identity — one voice, every conversation. */
const CONCIERGE_NAME = "Concierge";

// Suggestions exist only to unblock a blank page. They appear when the user has
// no conversations yet and disappear the moment they do.
const EXAMPLE_ASKS = [
  "Investigate this production error",
  "Prepare the next release",
  "Turn this idea into a small first step",
];

interface Props {
  defaultModel: string;
  repositories: RepositoryOption[];
  conversations: ConversationCard[];
  pulse: { needsYou: number; inMotion: number; total: number };
}

export function ConciergeHome({ defaultModel, repositories, conversations, pulse }: Props) {
  const router = useRouter();
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const [input, setInput] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showOptions, setShowOptions] = React.useState(false);

  const { model, setModel, modelOptions } = useModelOptions(defaultModel, true);
  const [reasoning, setReasoning] = React.useState<ThinkingLevel | null>(null);
  const [repoId, setRepoId] = React.useState<string>(repositories[0]?.id ?? "");

  const firstTime = conversations.length === 0;

  function grow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function applyExample(text: string) {
    setInput(text);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      // Height follows the value, which React applies on the next paint.
      requestAnimationFrame(grow);
    }
  }

  async function submit() {
    const text = input.trim();
    if (!text || pending) return;
    setError(null);
    setPending(true);
    try {
      // A conversation IS a chat run — same durable object /runs inspects, so
      // nothing here forks a second chat system. What makes it a *concierge*
      // conversation is the persona plus the `spawn` profile: the concierge
      // plans, files tasks and dispatches specialist runs on the user's behalf
      // instead of asking the user to pick an agent.
      const body = {
        goal: "<chat>",
        toolsProfile: "orchestrator,repo_write,spawn",
        cwdStrategy: repoId ? "repo" : "none",
        repoId: repoId || null,
        model,
        thinkingLevel: reasoning,
        personaId: "concierge",
      };
      let res = await postRun(body);
      if (res.status === 404) {
        // Deployment without the seeded concierge persona: still open the
        // conversation rather than dead-ending the user's first message.
        res = await postRun({ ...body, personaId: undefined });
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}) as { error?: string });
        setError(detail.error ?? `HTTP ${res.status}`);
        return;
      }
      const run = (await res.json()) as { id: number };

      // Hand the first message to the conversation view instead of posting it
      // here: RunView is the authoritative streamer for a turn, and a POST
      // followed by navigation would throw that turn's stream away.
      stashPendingMessage(run.id, text);
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100svh-48px)] w-full max-w-3xl flex-col gap-8 px-4 pb-16 pt-[max(4vh,32px)] sm:px-6">
      <div className={firstTime ? "flex flex-1 flex-col justify-center gap-8" : "flex flex-col gap-8"}>
        <header className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="flex size-8 items-center justify-center rounded-full border border-border/60 bg-card/60 text-foreground"
            >
              <Sparkles className="size-4" />
            </span>
            <span className="text-sm font-medium text-foreground">{CONCIERGE_NAME}</span>
            <span className="text-xs text-muted-foreground">Here now</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            <Greeting /> What would you like to move forward?
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Tell me the outcome. I can plan the work, bring in specialists, and come
            back to you with decisions and results.
          </p>
        </header>

        <section className="flex flex-col gap-2">
          <div className="rounded-2xl border border-border/60 bg-card/40 transition-colors focus-within:border-foreground/30">
            <ComposerTextarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                grow();
              }}
              onKeyDown={onKeyDown}
              placeholder={`Ask ${CONCIERGE_NAME.toLowerCase()} anything…`}
              disabled={pending}
              autoFocus
              className="w-full px-4 pb-2 pt-4 text-base"
              aria-label={`Message ${CONCIERGE_NAME}`}
            />
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
              <button
                type="button"
                onClick={() => setShowOptions((v) => !v)}
                aria-expanded={showOptions}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                <ChevronDown
                  className={`size-3 transition-transform ${showOptions ? "rotate-180" : ""}`}
                />
                Options
              </button>
              {repoId && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {repositories.find((r) => r.id === repoId)?.name ?? repoId}
                </span>
              )}
              <div className="flex-1" />
              <ComposerSendButton
                pending={pending}
                disabled={!input.trim()}
                onClick={submit}
                ariaLabel={`Send to ${CONCIERGE_NAME.toLowerCase()}`}
              />
            </div>
            {showOptions && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
                {repositories.length > 0 && (
                  <RepositoryPicker
                    repositories={repositories}
                    value={repoId}
                    onChange={setRepoId}
                    disabled={pending}
                    className="rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] font-mono text-foreground transition-colors hover:bg-muted/40 focus:border-foreground/30 focus:outline-none disabled:opacity-50"
                  />
                )}
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
              </div>
            )}
          </div>
          <ErrorText>{error}</ErrorText>

          {firstTime && (
            <div className="flex flex-wrap gap-2 pt-1">
              {EXAMPLE_ASKS.map((ask) => (
                <button
                  key={ask}
                  type="button"
                  onClick={() => applyExample(ask)}
                  className="rounded-full border border-border/60 bg-card/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                >
                  {ask}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {!firstTime && (
        <section className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between pb-1">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Conversations
            </h2>
            <Link
              href="/runs"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              All work
            </Link>
          </div>
          <ul className="flex flex-col">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/runs/${c.id}`}
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/30"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {c.title}
                  </span>
                  {c.stateLabel && <StateTag state={c.state} label={c.stateLabel} />}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {relativeDate(c.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="px-2 pt-2 text-xs text-muted-foreground">{pulseLine(pulse)}</p>
        </section>
      )}
    </div>
  );
}

function postRun(body: Record<string, unknown>) {
  return fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Attention, not activity: one line, and only when it says something true. */
function pulseLine(pulse: Props["pulse"]): string {
  if (pulse.needsYou > 0) {
    return pulse.needsYou === 1
      ? "1 conversation needs you."
      : `${pulse.needsYou} conversations need you.`;
  }
  if (pulse.inMotion > 0) {
    return pulse.inMotion === 1
      ? "Nothing needs you right now — 1 conversation is in motion."
      : `Nothing needs you right now — ${pulse.inMotion} conversations are in motion.`;
  }
  return "Nothing needs you right now.";
}

function StateTag({ state, label }: { state: ConversationCard["state"]; label: string }) {
  const tone =
    state === "needs_you"
      ? "border-state-blocked/40 text-state-blocked"
      : state === "in_motion"
        ? "border-state-progress/40 text-state-progress"
        : "border-border/60 text-muted-foreground";
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

/**
 * Rendered after mount only: the greeting depends on the reader's clock, and
 * the server has no business guessing it (nor triggering a hydration mismatch).
 */
function Greeting() {
  const [greeting, setGreeting] = React.useState<string | null>(null);
  React.useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.");
  }, []);
  if (!greeting) return null;
  return <span className="text-muted-foreground">{greeting} </span>;
}
