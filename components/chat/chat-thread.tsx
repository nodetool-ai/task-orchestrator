"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Sparkles } from "lucide-react";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatComposer, type ChatComposerHandle } from "@/components/chat/chat-composer";
import { ThreadErrorBanner } from "@/components/chat/thread-error-banner";
import { ModelPicker } from "@/components/chat/model-picker";
import type { ChatMessageRow, ChatRole, ChatRow } from "@/lib/types";
import type { SdkContentBlock, SdkMessageEnvelope } from "@/lib/sdk-message";
import { RepositoryPicker } from "@/components/pickers/repository-picker";

interface SidebarRepo {
  id: string;
  name: string;
  localPath: string | null;
}

interface Props {
  chat: ChatRow;
  initialMessages: ChatMessageRow[];
  userEmail: string | null;
  repoRoot: string;
  defaultModel: string;
  repositories: SidebarRepo[];
}

const MODEL_OPTIONS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001",
];

interface UiMessage {
  id: number;
  role: ChatRole;
  content: SdkContentBlock[];
}

let tmpIdCounter = -1;

export function ChatThread({
  chat,
  initialMessages,
  userEmail,
  repoRoot,
  defaultModel,
  repositories,
}: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState<UiMessage[]>(() =>
    initialMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content as SdkContentBlock[],
    }))
  );
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [model, setModel] = useState<string>(chat.model ?? defaultModel);
  const [repoId, setRepoId] = useState<string | null>(chat.repoId);
  const [savingModel, setSavingModel] = useState(false);
  const [savingRepo, setSavingRepo] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);

  async function patchChat(patch: Record<string, unknown>, onError: () => void) {
    try {
      const res = await fetch(`/api/chats/${chat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        setErrorMsg(body.error ?? `HTTP ${res.status}`);
        onError();
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      onError();
    }
  }

  async function changeModel(next: string) {
    if (next === model) return;
    const prev = model;
    setModel(next);
    setSavingModel(true);
    try {
      await patchChat({ model: next }, () => setModel(prev));
    } finally {
      setSavingModel(false);
    }
  }

  async function changeRepo(next: string) {
    if (next === (repoId ?? "")) return;
    const prev = repoId;
    setRepoId(next || null);
    setSavingRepo(true);
    try {
      await patchChat({ repoId: next || null }, () => setRepoId(prev));
    } finally {
      setSavingRepo(false);
      router.refresh();
    }
  }

  const selectedRepo = repositories.find((r) => r.id === repoId);
  const repoCwdHint = selectedRepo?.localPath ?? repoRoot;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  // Pair tool_use blocks with their matching tool_result by id so the result
  // renders inline under the call instead of as a floating row.
  const { resultByToolId, visibleMessages } = useMemo(() => {
    const map = new Map<string, SdkContentBlock>();
    for (const m of messages) {
      if (m.role !== "tool_result") continue;
      for (const b of m.content) {
        if (b.tool_use_id) map.set(b.tool_use_id, b);
      }
    }
    const visible = messages.filter((m) => {
      if (m.role !== "tool_result") return true;
      // Drop tool_result rows whose every block was paired with a known call.
      return m.content.some((b) => !b.tool_use_id || !map.has(b.tool_use_id));
    });
    return { resultByToolId: map, visibleMessages: visible };
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setErrorMsg(null);

    setMessages((prev) => [
      ...prev,
      { id: tmpIdCounter--, role: "user", content: [{ type: "text", text }] },
    ]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`/api/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        setErrorMsg(`HTTP ${res.status}`);
        return;
      }
      await consumeSse(res.body, handleStreamEvent);
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      router.refresh();
    }
  }

  function handleStreamEvent(event: ChatStreamEventClient) {
    if (event.type === "sdk" && event.sdk) {
      mergeSdk(event.sdk);
    } else if (event.type === "error") {
      setErrorMsg(event.error ?? "Unknown error");
    }
  }

  function mergeSdk(m: SdkMessageEnvelope) {
    if (m.type === "assistant" && m.message?.content) {
      const blocks = m.message.content;
      if (blocks.length === 0) return;
      setMessages((prev) => [
        ...prev,
        { id: tmpIdCounter--, role: "assistant", content: blocks },
      ]);
    } else if (m.type === "user" && m.message?.content) {
      const toolResults = m.message.content.filter((b) => b.type === "tool_result");
      if (toolResults.length === 0) return;
      setMessages((prev) => [
        ...prev,
        { id: tmpIdCounter--, role: "tool_result", content: toolResults },
      ]);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const empty = messages.length === 0;
  const greeting = greetingFor(new Date(), userEmail);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/60 bg-background/60 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-2 text-sm">
          <Sparkles className="size-3.5 text-state-review" />
          <span className="truncate font-medium">{chat.title}</span>
          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor={`repo-${chat.id}`}>
              Repository
            </label>
            <RepositoryPicker
              id={`repo-${chat.id}`}
              repositories={repositories}
              value={repoId ?? ""}
              onChange={changeRepo}
              disabled={savingRepo || repositories.length === 0}
              emptyLabel={repositories.length === 0 ? "no repos" : null}
              showId
              className="rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] font-mono text-foreground transition-colors hover:bg-muted/40 focus:border-foreground/30 focus:outline-none disabled:opacity-50"
            />
            <ModelPicker
              id={`model-${chat.id}`}
              value={model}
              options={MODEL_OPTIONS}
              onChange={changeModel}
              disabled={savingModel}
            />
          </div>
        </div>
        <div
          className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
          title={repoCwdHint}
        >
          cwd: {repoCwdHint}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="mx-auto max-w-2xl px-6 py-16">
            <h1 className="text-3xl font-semibold tracking-tight">{greeting.title}</h1>
            <p className="mt-2 text-muted-foreground">{greeting.subtitle}</p>
            <div className="mt-8 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => composerRef.current?.setValue(s)}
                  className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 text-left text-sm text-foreground/90 transition-colors hover:border-foreground/20 hover:bg-muted/50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl pb-2">
            {visibleMessages.map((m) => (
              <ChatMessage
                key={m.id}
                role={m.role}
                content={m.content}
                resultByToolId={resultByToolId}
              />
            ))}
            {sending && <ThinkingIndicator />}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <ChatComposer
        ref={composerRef}
        value={input}
        onChange={setInput}
        onSubmit={send}
        onStop={stop}
        sending={sending}
        header={
          errorMsg ? (
            <ThreadErrorBanner error={errorMsg} onDismiss={() => setErrorMsg(null)} />
          ) : null
        }
        hint={
          <>
            Claude Agent SDK · runs against this repo with bash + edit tools.
          </>
        }
      />
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex gap-3 px-4 py-4">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card text-foreground">
        <Bot className="size-3.5" />
      </div>
      <div className="rounded-2xl rounded-bl-sm bg-secondary/60 px-4 py-2.5">
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 animate-pulse rounded-full bg-foreground/60" />
          <span className="size-1.5 animate-pulse rounded-full bg-foreground/60 [animation-delay:120ms]" />
          <span className="size-1.5 animate-pulse rounded-full bg-foreground/60 [animation-delay:240ms]" />
        </span>
      </div>
    </div>
  );
}

interface ChatStreamEventClient {
  type: "user_message" | "sdk" | "done" | "error";
  sdk?: SdkMessageEnvelope;
  error?: string;
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEventClient) => void
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as ChatStreamEventClient);
        } catch {
          // ignore malformed frames
        }
      }
    }
  }
}

const SUGGESTIONS = [
  "Summarise the current state of the orchestrator repo.",
  "Show me which tasks are blocked and why.",
  "Draft a release note for the latest changes on main.",
  "What's the largest file in /lib and what does it do?",
];

function greetingFor(now: Date, email: string | null): { title: string; subtitle: string } {
  const hour = now.getHours();
  const part =
    hour < 5
      ? "Working late"
      : hour < 12
      ? "Good morning"
      : hour < 18
      ? "Good afternoon"
      : "Good evening";
  const name = email ? email.split("@")[0].replace(/[._]/g, " ") : null;
  return {
    title: name ? `${part}, ${name}.` : `${part}.`,
    subtitle: "How can I help you today?",
  };
}
