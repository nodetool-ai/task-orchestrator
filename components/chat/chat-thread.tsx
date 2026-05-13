"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Bot, Square, Sparkles } from "lucide-react";
import { ChatMessage } from "@/components/chat/chat-message";
import type { ChatMessageRow, ChatRole, ChatRow } from "@/lib/types";
import type { SdkContentBlock, SdkMessageEnvelope } from "@/lib/sdk-message";

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

// In-flight optimistic messages get a temporary negative id so they don't
// collide with persisted rows on the next refresh.
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

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

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const empty = messages.length === 0;
  const greeting = greetingFor(new Date(), userEmail);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/60 px-5 py-3 space-y-1">
        <div className="flex items-center gap-2 text-sm">
          <Sparkles className="size-3.5 text-state-review" />
          <span className="font-medium truncate">{chat.title}</span>
          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor={`repo-${chat.id}`}>Repository</label>
            <select
              id={`repo-${chat.id}`}
              value={repoId ?? ""}
              onChange={(e) => changeRepo(e.target.value)}
              disabled={savingRepo || repositories.length === 0}
              className="rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] font-mono text-foreground hover:bg-muted/40 focus:outline-none focus:border-foreground/30 disabled:opacity-50"
            >
              {repositories.length === 0 && <option value="">no repos</option>}
              {repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.id})
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`model-${chat.id}`}>Model</label>
            <select
              id={`model-${chat.id}`}
              value={MODEL_OPTIONS.includes(model) ? model : "__custom"}
              onChange={(e) => {
                if (e.target.value === "__custom") return;
                changeModel(e.target.value);
              }}
              disabled={savingModel}
              className="rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] font-mono text-foreground hover:bg-muted/40 focus:outline-none focus:border-foreground/30 disabled:opacity-50"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              {!MODEL_OPTIONS.includes(model) && (
                <option value="__custom">{model}</option>
              )}
            </select>
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground font-mono truncate" title={repoCwdHint}>
          cwd: {repoCwdHint}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="mx-auto max-w-2xl px-6 py-16">
            <h1 className="text-3xl font-semibold tracking-tight">{greeting.title}</h1>
            <p className="mt-2 text-muted-foreground">{greeting.subtitle}</p>
            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setInput(s);
                    textareaRef.current?.focus();
                  }}
                  className="text-left rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 text-sm text-foreground/90 hover:bg-muted/50 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl">
            {messages.map((m) => (
              <ChatMessage key={m.id} role={m.role} content={m.content} />
            ))}
            {sending && <ThinkingIndicator />}
            {errorMsg && (
              <pre className="mx-4 my-2 rounded-md border border-state-blocked/40 bg-state-blocked/10 px-3 py-2 text-[11px] leading-5 font-mono whitespace-pre-wrap text-state-blocked overflow-x-auto">
                {errorMsg}
              </pre>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border/60 bg-background/80 backdrop-blur px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card/60 px-3 py-2 focus-within:border-foreground/30 transition-colors">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask anything…"
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none py-1.5 max-h-48"
            />
            {sending ? (
              <button
                type="button"
                onClick={stop}
                className="inline-flex size-8 items-center justify-center rounded-full bg-state-blocked/80 text-background hover:bg-state-blocked transition-colors"
                aria-label="Stop"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!input.trim()}
                className="inline-flex size-8 items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:opacity-40 disabled:hover:bg-foreground transition-colors"
                aria-label="Send"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground text-center">
            Claude Agent SDK · runs against this repo with bash + edit tools.
          </p>
        </div>
      </div>
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
        <span className="inline-flex gap-1 items-center">
          <span className="size-1.5 rounded-full bg-foreground/60 animate-pulse" />
          <span className="size-1.5 rounded-full bg-foreground/60 animate-pulse [animation-delay:120ms]" />
          <span className="size-1.5 rounded-full bg-foreground/60 animate-pulse [animation-delay:240ms]" />
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
  const part = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = email ? email.split("@")[0].replace(/[._]/g, " ") : null;
  return {
    title: name ? `${part}, ${name}.` : `${part}.`,
    subtitle: "How can I help you today?",
  };
}
