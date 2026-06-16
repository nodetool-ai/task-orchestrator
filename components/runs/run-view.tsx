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
  TerminalSquare,
  UserRound,
  X,
} from "lucide-react";
import { cn, formatDateTime } from "@/lib/utils";
import { TerminalView } from "@/components/runs/terminal-view";
import { isTerminalStatus, type SessionStatus } from "@/lib/types";
import type { RunRow, MessageRow } from "@/lib/runs";
import type { SdkContentBlock, SdkMessageEnvelope } from "@/lib/sdk-message";
import { SessionStatusPill } from "@/components/session-status-pill";
import { RunMessage } from "@/components/runs/run-message";
import { SystemEventRow } from "@/components/runs/system-event-row";
import { useConfirm } from "@/components/ui/dialog-provider";

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
  type: "user_message" | "sdk" | "done" | "error" | "status" | "system" | "_eos";
  message?: MessageRow;
  sdk?: SdkMessageEnvelope;
  status?: SessionStatus;
  error?: string;
  /** `system` events (lib/runs.ts systemNote): {kind: SystemKind, …payload}. */
  payload?: Record<string, unknown>;
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
  const confirm = useConfirm();
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
  const didInitialScrollRef = useRef(false);

  const status = run.status;
  const terminal = isTerminalStatus(status);
  const hasTerminal =
    run.harness === "claude_cli" && !!run.tmuxSession && !terminal;
  const [terminalOpen, setTerminalOpen] = useState(hasTerminal);
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

  // Auto-scroll on new content. First load jumps instantly; later updates animate.
  useEffect(() => {
    const behavior: ScrollBehavior = didInitialScrollRef.current ? "smooth" : "auto";
    endRef.current?.scrollIntoView({ behavior, block: "end" });
    didInitialScrollRef.current = true;
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
    if (event.type === "system" && event.payload) {
      // Live system notes from the worker (e.g. the Claude-CLI harness's
      // attach hint or needs-login warning). The persisted copy renders on
      // reload via extractSystemMeta; this makes it appear in real time.
      // Carry `text` as a content block so SystemEventRow renders prose
      // instead of the JSON payload fallback.
      const { kind, text, ...rest } = event.payload as {
        kind?: string;
        text?: string;
      } & Record<string, unknown>;
      setMessages((prev) => [
        ...prev,
        {
          id: nextTmpId(),
          role: "system",
          content: typeof text === "string" ? [{ type: "text", text }] : [],
          createdAt: new Date(),
          systemKind: (kind as SystemKind) ?? "info",
          systemPayload:
            typeof text === "string" ? { message: text, ...rest } : rest,
        },
      ]);
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
    if (
      !(await confirm({
        message: "Close this run? Any in-flight turn is cancelled.",
        confirmLabel: "Close run",
        tone: "danger",
      }))
    )
      return;
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
    if (
      !(await confirm({
        message: "Cancel the in-flight turn?",
        confirmLabel: "Cancel turn",
        cancelLabel: "Keep running",
        tone: "danger",
      }))
    )
      return;
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

  // `status` transitions are conveyed by the header pill — suppress them
  // from the timeline so users don't see `status → running` repeated next
  // to a "Running" badge that says the same thing.
  const visibleMessages = useMemo(
    () => messages.filter((m) => !(m.role === "system" && m.systemKind === "status")),
    [messages]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b border-border/60 bg-background px-6 py-3">
        <div className="flex items-center gap-3 min-w-0">
          {parent && (
            <Link
              href={`/runs/${parent.id}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground shrink-0"
              title={`parent: ${parent.title}`}
            >
              <ChevronLeft className="size-3.5" />
            </Link>
          )}
          <h1 className="text-base font-semibold tracking-tight truncate min-w-0">
            {title}
          </h1>
          <span className="text-[11px] font-mono text-muted-foreground/70 tabular-nums shrink-0">
            #{run.id}
          </span>
          <div className="flex-1" />
          <SessionStatusPill status={status} />
          {run.prUrl && (
            <a
              className="text-xs text-muted-foreground underline decoration-muted-foreground/40 hover:text-foreground hover:decoration-foreground shrink-0"
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
              className="inline-flex items-center gap-1 rounded-md border border-state-blocked/30 bg-state-blocked/10 px-2 py-0.5 text-[11px] text-state-blocked hover:bg-state-blocked/15 transition-colors shrink-0"
            >
              <Square className="size-3" /> Cancel
            </button>
          )}
          {canClose && !canCancel && (
            <button
              type="button"
              onClick={close}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/40 shrink-0"
            >
              <X className="size-3" /> Close
            </button>
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80">
          {personaName && (
            <span className="inline-flex items-center gap-1">
              <UserRound className="size-3" />
              <span>{personaName}</span>
            </span>
          )}
          {run.model && (
            <span className="inline-flex items-center gap-1">
              <Cpu className="size-3" />
              <code className="font-mono">{run.model}</code>
            </span>
          )}
          <span className="inline-flex items-center gap-1 min-w-0" title={cwdHint}>
            <FolderClosed className="size-3 shrink-0" />
            <code className="font-mono truncate max-w-[280px]">{cwdHint}</code>
          </span>
          {run.branch && (
            <span className="inline-flex items-center gap-1 min-w-0" title={run.branch}>
              <GitBranch className="size-3 shrink-0" />
              <code className="font-mono truncate max-w-[180px]">{run.branch}</code>
            </span>
          )}
          {run.harness === "claude_cli" && run.tmuxSession && !terminal && (
            <span
              className="inline-flex items-center gap-1"
              title="Claude Code runs inside this tmux session — attach to watch or steer"
            >
              <TerminalSquare className="size-3 shrink-0" />
              <code className="font-mono">tmux attach -t {run.tmuxSession}</code>
            </span>
          )}
          {hasTerminal && (
            <button
              type="button"
              onClick={() => setTerminalOpen((o) => !o)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-colors",
                terminalOpen
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5"
              )}
              title={terminalOpen ? "Hide terminal" : "Show live terminal"}
            >
              <TerminalSquare className="size-3" />
              {terminalOpen ? "hide terminal" : "terminal"}
            </button>
          )}
          {task && (
            <Link
              href={`/tasks/${task.id}`}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <code className="font-mono">{task.id}</code>
            </Link>
          )}
          {run.goal && run.goal !== "<implement>" && run.goal !== "<chat>" && (
            <span className="truncate">{run.goal}</span>
          )}
        </div>
      </header>

      {/* Live terminal — only for running claude_cli runs */}
      {hasTerminal && terminalOpen && run.tmuxSession && (
        <TerminalView runId={run.id} tmuxSession={run.tmuxSession} />
      )}

      {/* Message stream */}
      <div className="flex-1 overflow-y-auto bg-background">
        {empty ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">
              {greeting.title}
            </h2>
            <p className="mt-2 text-muted-foreground">{greeting.subtitle}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl py-6">
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
        <div className="border-t border-border/60 bg-background px-4 py-3">
          <div className="mx-auto max-w-3xl">
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
            {(run.startedAt || run.totalCostUsd != null) && (
              <p className="mt-1.5 text-[10px] text-muted-foreground/70 text-center tabular-nums">
                {run.startedAt && `Started ${formatDateTime(run.startedAt)}`}
                {run.totalCostUsd != null && (
                  <> · ${run.totalCostUsd.toFixed(4)}</>
                )}
              </p>
            )}
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
    <div className="px-4 py-3">
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
