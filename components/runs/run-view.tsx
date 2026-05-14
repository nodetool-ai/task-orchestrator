"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  ChevronLeft,
  Cpu,
  FolderClosed,
  GitBranch,
  Square,
  UserRound,
  X,
} from "lucide-react";
import { cn, formatDateTime } from "@/lib/utils";
import { isTerminalStatus, type SessionStatus } from "@/lib/types";
import type { RunRow, MessageRow } from "@/lib/runs";
import type { SdkContentBlock, SdkMessageEnvelope } from "@/lib/sdk-message";
import { SessionStatusPill } from "@/components/session-status-pill";
import { RunMessage } from "@/components/runs/run-message";
import { SystemEventRow } from "@/components/runs/system-event-row";

interface SidebarRepo {
  id: string;
  name: string;
  localPath: string | null;
}

interface Props {
  run: RunRow;
  initialMessages: MessageRow[];
  live: boolean;
  userEmail: string | null;
  repositories: SidebarRepo[];
  parent: { id: number; title: string } | null;
  task: { id: string; title: string } | null;
  personaName: string | null;
}

// In-flight optimistic messages get a temporary negative id so they don't
// collide with persisted rows on the next refresh.
type UiRole = MessageRow["role"];
interface UiMessage {
  id: number;
  role: UiRole;
  content: SdkContentBlock[];
  /** Wall-clock timestamp; system events use this to render their header. */
  createdAt?: Date;
  /** Free-form sub-kind for system events (worktree/pr/branch/budget). */
  systemKind?: SystemKind;
  /** Optional structured payload for the system row to render. */
  systemPayload?: Record<string, unknown>;
}

export type SystemKind =
  | "worktree"
  | "pr"
  | "pr_merged"
  | "branch"
  | "budget"
  | "status"
  | "error"
  | "info"
  // From the legacy `agent_events` types backfilled into agent_messages by
  // migration 0009:
  | "shell"
  | "shell_out"
  | "stderr"
  | "warning"
  | "prompt"
  | "resume";

let tmpIdCounter = -1;
const nextTmpId = () => tmpIdCounter--;

interface StreamEventClient {
  type: "user_message" | "sdk" | "done" | "error" | "status" | "_eos";
  message?: MessageRow;
  sdk?: SdkMessageEnvelope;
  status?: SessionStatus;
  error?: string;
}

export function RunView({
  run: initialRun,
  initialMessages,
  live,
  userEmail,
  repositories,
  parent,
  task,
  personaName,
}: Props) {
  const router = useRouter();
  const [run, setRun] = useState<RunRow>(initialRun);
  const [messages, setMessages] = useState<UiMessage[]>(() =>
    initialMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      // Persisted system messages store the event type inside the first
      // content block (migration 0009 wrote `[{type: <event_type>, ...payload}]`).
      // Surface it as systemKind so SystemEventRow doesn't fall through to
      // the JSON fallback for everything.
      ...(m.role === "system" ? extractSystemMeta(m.content) : {}),
    }))
  );
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const status = run.status;
  const terminal = isTerminalStatus(status);
  const closed = status === "closed";
  const composerDisabled = closed;
  const canCancel =
    status === "running" ||
    status === "preparing" ||
    status === "pushing" ||
    status === "opening_pr";
  const canClose = !closed;

  const selectedRepo = useMemo(
    () => repositories.find((r) => r.id === run.repoId),
    [repositories, run.repoId]
  );
  const cwdHint =
    run.worktreePath ?? selectedRepo?.localPath ?? "(orchestrator checkout)";

  // Auto-scroll on new content.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  // Auto-grow the textarea.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  // Live read-only SSE: subscribes to /events for status transitions, system
  // events emitted by the implement worker, and SDK envelopes produced by a
  // turn we did NOT initiate (e.g. another tab posted a message, or the
  // initial implement worker is still running). On terminal status the
  // server sends `_eos` and we close.
  useEffect(() => {
    if (terminal && status !== "idle") return;
    const url = `/api/runs/${run.id}/events`;
    const es = new EventSource(url);
    es.onmessage = (msg) => {
      let parsed: StreamEventClient;
      try {
        parsed = JSON.parse(msg.data) as StreamEventClient;
      } catch {
        return;
      }
      handleSseEvent(parsed);
      if (parsed.type === "_eos") {
        es.close();
        router.refresh();
      }
    };
    es.onerror = () => {
      es.close();
    };
    return () => es.close();
    // We intentionally re-subscribe when `terminal`/`status` flips so a run
    // that resumes (idle → running) reconnects without a full reload.
  }, [run.id, terminal, status, router]);

  function handleSseEvent(event: StreamEventClient) {
    if (event.type === "status" && event.status) {
      setRun((r) => ({ ...r, status: event.status! }));
      // Status transitions show up inline as a compact system row so the
      // user can see "running → idle → running" in the timeline.
      appendSystemEvent("status", { status: event.status });
      return;
    }
    if (event.type === "sdk" && event.sdk) {
      mergeSdkEnvelope(event.sdk);
      return;
    }
    if (event.type === "error") {
      setErrorMsg(event.error ?? "Unknown error");
    }
  }

  function mergeSdkEnvelope(m: SdkMessageEnvelope) {
    if (m.type === "assistant" && m.message?.content) {
      const blocks = m.message.content;
      if (blocks.length === 0) return;
      setMessages((prev) => [
        ...prev,
        { id: nextTmpId(), role: "agent", content: blocks },
      ]);
    } else if (m.type === "user" && m.message?.content) {
      const toolResults = m.message.content.filter((b) => b.type === "tool_result");
      if (toolResults.length === 0) return;
      setMessages((prev) => [
        ...prev,
        { id: nextTmpId(), role: "tool", content: toolResults },
      ]);
    }
  }

  function appendSystemEvent(kind: SystemKind, payload: Record<string, unknown>) {
    setMessages((prev) => [
      ...prev,
      {
        id: nextTmpId(),
        role: "system",
        content: [],
        createdAt: new Date(),
        systemKind: kind,
        systemPayload: payload,
      },
    ]);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending || composerDisabled) return;
    setInput("");
    setSending(true);
    setErrorMsg(null);

    // Optimistic user message — keyed by a temp negative id so the next
    // server refresh can swap it in without flickering.
    setMessages((prev) => [
      ...prev,
      { id: nextTmpId(), role: "user", content: [{ type: "text", text }] },
    ]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`/api/runs/${run.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        setErrorMsg(`HTTP ${res.status}`);
        return;
      }
      await consumeSse(res.body, (event) => {
        if (event.type === "sdk" && event.sdk) {
          mergeSdkEnvelope(event.sdk);
        } else if (event.type === "error") {
          setErrorMsg(event.error ?? "Unknown error");
        } else if (event.type === "user_message" && event.message) {
          // Already optimistically rendered. We let the next router.refresh
          // reconcile id swaps.
        }
      });
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

  function stop() {
    abortRef.current?.abort();
  }

  async function close() {
    if (!canClose) return;
    if (!confirm("Close this run? Any in-flight turn is cancelled.")) return;
    try {
      const res = await fetch(`/api/runs/${run.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const updated = (await res.json()) as RunRow;
      setRun(updated);
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function cancel() {
    if (!canCancel) return;
    if (!confirm("Cancel the in-flight turn?")) return;
    try {
      const res = await fetch(`/api/runs/${run.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const updated = (await res.json()) as RunRow;
      setRun(updated);
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const title = run.title ?? task?.title ?? (run.goal === "<chat>" ? "Chat" : `Run #${run.id}`);
  const placeholder =
    status === "idle"
      ? "Ask anything…"
      : status === "running"
        ? "Send another message — it will queue."
        : closed
          ? "This run is closed."
          : "Message the agent…";

  const empty = messages.length === 0;
  const greeting = useMemo(() => greetingFor(new Date(), userEmail), [userEmail]);

  // Drop consecutive duplicate `status` events. The runner emits both a live
  // bus event and a persisted row for each transition, so reloading often
  // shows the same `status → running` twice in a row.
  const visibleMessages = useMemo(() => {
    const out: UiMessage[] = [];
    let lastStatus: string | null = null;
    for (const m of messages) {
      if (m.role === "system" && m.systemKind === "status") {
        const s = String((m.systemPayload as { status?: unknown })?.status ?? "");
        if (s === lastStatus) continue;
        lastStatus = s;
      } else {
        lastStatus = null;
      }
      out.push(m);
    }
    return out;
  }, [messages]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b border-border/60 bg-gradient-to-b from-background to-background/60 px-6 py-4 space-y-2.5">
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.08em] text-muted-foreground/70">
          {parent && (
            <Link
              href={`/runs/${parent.id}`}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ChevronLeft className="size-3" />
              <span className="truncate max-w-[180px] normal-case tracking-normal">
                parent: {parent.title}
              </span>
            </Link>
          )}
          <span className="tabular-nums">run #{run.id}</span>
          {run.goal && run.goal !== "<implement>" && run.goal !== "<chat>" && (
            <span className="truncate normal-case tracking-normal">· {run.goal}</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight truncate flex-1 min-w-0">
            {title}
          </h1>
          <SessionStatusPill status={status} />
          {task && (
            <Link
              href={`/tasks/${task.id}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/40 px-2 py-0.5 text-xs hover:bg-secondary"
            >
              <span className="font-mono text-muted-foreground">{task.id}</span>
            </Link>
          )}
          {run.branch && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
              title={run.branch}
            >
              <GitBranch className="size-3" />
              <span className="truncate max-w-[160px]">{run.branch}</span>
            </span>
          )}
          {run.prUrl && (
            <a
              className="text-xs text-foreground underline decoration-muted-foreground hover:decoration-foreground"
              href={run.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              PR ↗
            </a>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={cancel}
              className="inline-flex items-center gap-1 rounded-md border border-state-blocked/30 bg-state-blocked/10 px-2 py-0.5 text-[11px] text-state-blocked hover:bg-state-blocked/15 transition-colors"
            >
              <Square className="size-3" /> Cancel
            </button>
          )}
          {canClose && !canCancel && (
            <button
              type="button"
              onClick={close}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] hover:bg-muted/40"
            >
              <X className="size-3" /> Close
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {personaName && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-secondary/30 px-1.5 py-0.5 text-muted-foreground">
              <UserRound className="size-3" />
              <span className="text-foreground/90">{personaName}</span>
            </span>
          )}
          {run.model && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-secondary/30 px-1.5 py-0.5 text-muted-foreground">
              <Cpu className="size-3" />
              <code className="font-mono text-foreground/90">{run.model}</code>
            </span>
          )}
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-secondary/30 px-1.5 py-0.5 text-muted-foreground min-w-0"
            title={cwdHint}
          >
            <FolderClosed className="size-3 shrink-0" />
            <code className="font-mono text-foreground/90 truncate max-w-[280px]">{cwdHint}</code>
          </span>
        </div>
      </header>

      {/* Message stream */}
      <div className="flex-1 overflow-y-auto bg-gradient-to-b from-background via-background to-muted/10">
        {empty ? (
          <div className="mx-auto max-w-2xl px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">
              {greeting.title}
            </h2>
            <p className="mt-2 text-muted-foreground">{greeting.subtitle}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl py-4">
            {visibleMessages.map((m) =>
              m.role === "system" ? (
                <SystemEventRow
                  key={m.id}
                  when={m.createdAt ?? new Date()}
                  kind={m.systemKind ?? "info"}
                  payload={m.systemPayload ?? {}}
                  content={m.content}
                />
              ) : (
                <RunMessage key={m.id} role={m.role} content={m.content} />
              )
            )}
            {sending && <ThinkingIndicator />}
            {errorMsg && (
              <pre className="mx-4 my-2 rounded-md border border-state-blocked/40 bg-state-blocked/10 px-3 py-2 text-[11px] leading-5 font-mono whitespace-pre-wrap text-state-blocked overflow-x-auto">
                {errorMsg}
              </pre>
            )}
            {run.error && (
              <pre className="mx-4 my-2 rounded-md border border-state-blocked/40 bg-state-blocked/10 px-3 py-2 text-[11px] leading-5 font-mono whitespace-pre-wrap text-state-blocked overflow-x-auto">
                {run.error}
              </pre>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* Composer — present for every status except `closed` */}
      {!closed && (
        <div className="border-t border-border/60 bg-background/95 backdrop-blur px-4 py-4">
          <div className="mx-auto max-w-3xl">
            {status === "running" && (
              <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-state-progress/30 bg-state-progress/10 px-2 py-0.5 text-[10px] text-state-progress">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-state-progress opacity-75" />
                  <span className="relative inline-flex rounded-full size-1.5 bg-state-progress" />
                </span>
                Agent is running — next message will queue.
              </div>
            )}
            <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card/60 px-3 py-2 focus-within:border-foreground/40 focus-within:ring-2 focus-within:ring-foreground/10 transition-all">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                rows={1}
                disabled={composerDisabled}
                className="flex-1 resize-none bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none py-1.5 max-h-48 disabled:opacity-50"
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
                  disabled={!input.trim() || composerDisabled}
                  className="inline-flex size-8 items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:opacity-40 disabled:hover:bg-foreground transition-colors"
                  aria-label="Send"
                >
                  <ArrowUp className="size-4" />
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground text-center">
              {run.startedAt ? `Started ${formatDateTime(run.startedAt)}` : ""}
              {run.totalCostUsd != null && (
                <> · ${run.totalCostUsd.toFixed(4)}</>
              )}
            </p>
          </div>
        </div>
      )}
      {closed && (
        <div className="border-t border-border/60 bg-muted/30 px-4 py-3 text-center text-xs text-muted-foreground">
          This run is closed.
          {run.prUrl && (
            <>
              {" "}
              <a
                className="underline hover:text-foreground"
                href={run.prUrl}
                target="_blank"
                rel="noreferrer"
              >
                View PR
              </a>
              .
            </>
          )}
        </div>
      )}
    </div>
  );

  // `live` is intentionally unused for now (SSE always reconnects on mount
  // unless the run is terminal). Keep the prop so the server page can opt
  // out cheaply in the future.
  void live;
}

function ThinkingIndicator() {
  return (
    <div className="flex gap-3 px-4 py-4">
      <div className="rounded-2xl rounded-bl-sm bg-secondary/60 px-4 py-2.5">
        <span className="inline-flex gap-1 items-center">
          <span className="size-1.5 rounded-full bg-foreground/60 animate-pulse" />
          <span
            className={cn(
              "size-1.5 rounded-full bg-foreground/60 animate-pulse",
              "[animation-delay:120ms]"
            )}
          />
          <span
            className={cn(
              "size-1.5 rounded-full bg-foreground/60 animate-pulse",
              "[animation-delay:240ms]"
            )}
          />
        </span>
      </div>
    </div>
  );
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEventClient) => void
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
          onEvent(JSON.parse(line.slice(6)) as StreamEventClient);
        } catch {
          // ignore malformed frames
        }
      }
    }
  }
}

// Persisted system messages were written by migration 0009 (and by live
// `runs.append` inserts) as a single content block: [{type:<kind>, …payload}].
// Pull the kind + payload back out so SystemEventRow can render them with
// the right icon/format instead of the JSON fallback.
function extractSystemMeta(content: SdkContentBlock[]):
  | { systemKind: SystemKind; systemPayload: Record<string, unknown> }
  | object {
  const first = content?.[0];
  if (!first || typeof first !== "object") return {};
  const raw = first as Record<string, unknown>;
  const kind = typeof raw.type === "string" ? (raw.type as SystemKind) : undefined;
  if (!kind) return {};
  const { type: _drop, ...payload } = raw;
  void _drop;
  return { systemKind: kind, systemPayload: payload };
}

function greetingFor(
  now: Date,
  email: string | null
): { title: string; subtitle: string } {
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
