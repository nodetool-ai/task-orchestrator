"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  ChevronLeft,
  Brain,
  Cpu,
  FolderClosed,
  GitBranch,
  Square,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";
import { isTerminalStatus, type SessionStatus } from "@/lib/types";
import type { RunRow, MessageRow } from "@/lib/runs";
import type { SdkContentBlock, SdkMessageEnvelope } from "@/lib/sdk-message";
import { SessionStatusPill } from "@/components/session-status-pill";
import { RunMessage, ToolUseBlock } from "@/components/runs/run-message";
import { ToolGroup } from "@/components/tool-group";
import { segmentToolMessages } from "@/lib/tool-grouping";
import { SystemEventRow } from "@/components/runs/system-event-row";
import { PlanningReviewCard } from "@/components/runs/planning-review-card";
import { useConfirm } from "@/components/ui/dialog-provider";
import { takePendingMessage } from "@/lib/pending-first-message";

interface SidebarRepo {
  id: string;
  name: string;
  localPath: string | null;
}

interface Props {
  run: RunRow;
  initialMessages: MessageRow[];
  /** Max message/event ids at server render; seeds the read-only SSE tail. */
  initialCursor: { msgId: number; evtId: number };
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
  type:
    | "user_message"
    | "sdk"
    | "message"
    | "done"
    | "error"
    | "status"
    | "_cursor"
    | "_eos";
  message?: MessageRow;
  sdk?: SdkMessageEnvelope;
  status?: SessionStatus;
  error?: string;
  cursor?: { msgId: number; evtId: number };
}

export function RunView({
  run: initialRun,
  initialMessages,
  initialCursor,
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
    initialMessages.map(toUiMessage)
  );
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const didInitialScrollRef = useRef(false);
  const handoffSentRef = useRef(false);
  // Mirror live state into refs so effects can read the latest value without
  // listing it as a dependency (which would tear down long-lived subscriptions
  // or clobber in-flight rows on every transition).
  const statusRef = useRef(run.status);
  const sendingRef = useRef(false);
  // Live tail cursor for the read-only /events SSE. Seeded from the server
  // snapshot so the stream forwards only rows written after this render, and
  // advanced by `_cursor` frames so a reconnect can resume without a gap.
  const streamCursorRef = useRef(initialCursor);
  // The initial `messages` state already reflects the first `initialMessages`,
  // so skip the reconciliation effect's very first run.
  const initialMessagesSyncedRef = useRef(false);

  const status = run.status;
  const terminal = isTerminalStatus(status);
  statusRef.current = status;
  sendingRef.current = sending;
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

  // Reconcile with server props. `messages` is seeded from a useState
  // initializer, so without this a router.refresh() (after a send, a close, or
  // a sibling tab posting) would never reach the UI. When a turn is streaming
  // we keep the live optimistic/streamed rows and only fold in server rows we
  // don't already have; otherwise the persisted rows are authoritative and
  // replace the temp rows (swapping tmp negative ids for real ones).
  useEffect(() => {
    if (!initialMessagesSyncedRef.current) {
      initialMessagesSyncedRef.current = true;
      return;
    }
    const serverMsgs = initialMessages.map(toUiMessage);
    setMessages((prev) => {
      if (sendingRef.current) {
        const have = new Set(prev.map((m) => m.id));
        const additions = serverMsgs.filter((m) => !have.has(m.id));
        return additions.length ? [...prev, ...additions] : prev;
      }
      return serverMsgs;
    });
  }, [initialMessages]);

  // Live read-only SSE: subscribes to /events for status transitions, system
  // events emitted by the implement worker, and SDK envelopes produced by a
  // turn we did NOT initiate (e.g. another tab posted a message, or the
  // initial implement worker is still running). On terminal status the
  // server sends `_eos` and we close.
  //
  // Subscribe once per run.id. The endpoint has no replay cursor, so tearing
  // the EventSource down on every status transition (as an effect that depends
  // on `status` would) drops any events emitted during the reconnect gap. We
  // read the live status from `statusRef` to decide whether to open at all and
  // rely on the server's `_eos` frame to close a run that reaches a terminal
  // status.
  useEffect(() => {
    if (isTerminalStatus(statusRef.current) && statusRef.current !== "idle") return;
    const { msgId, evtId } = streamCursorRef.current;
    const url = `/api/runs/${run.id}/events?msgCursor=${msgId}&evtCursor=${evtId}`;
    const es = new EventSource(url);
    es.onmessage = (msg) => {
      let parsed: StreamEventClient;
      try {
        parsed = JSON.parse(msg.data) as StreamEventClient;
      } catch {
        return;
      }
      // Cursor bookkeeping: track the tail position so a reconnect resumes
      // cleanly. Not a domain event, so it never reaches handleSseEvent.
      if (parsed.type === "_cursor") {
        if (parsed.cursor) streamCursorRef.current = parsed.cursor;
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
    // Subscribe once per run; status transitions are tracked via statusRef and
    // handled by the `_eos` frame instead of re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, router]);

  // First-message handoff: the /chat composer stashes a brand-new run's first
  // message and navigates here. Send it through the normal optimistic + SSE
  // path so it renders identically to every subsequent message. Read-once
  // storage plus the ref guard make this safe under StrictMode and refreshes.
  useEffect(() => {
    if (handoffSentRef.current) return;
    const pending = takePendingMessage(run.id);
    if (pending) {
      handoffSentRef.current = true;
      void sendText(pending);
    }
    // Mount-only for this run; sendText is a stable closure for a fresh run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  function handleStageChange(newStage: string) {
    setRun((r) => ({ ...r, planningStage: newStage }));
  }

  function handleRequestChanges(hint: string) {
    setInput(hint);
    // Defer focus so the textarea is present in the DOM.
    setTimeout(() => {
      textareaRef.current?.focus();
      // Move caret to the end.
      const el = textareaRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    }, 0);
  }

  function handleSseEvent(event: StreamEventClient) {
    if (event.type === "status" && event.status) {
      setRun((r) => ({ ...r, status: event.status! }));
      // Status transitions show up inline as a compact system row so the
      // user can see "running → idle → running" in the timeline.
      appendSystemEvent("status", { status: event.status });
      return;
    }
    // The read-only tail delivers assistant/tool/system rows as persisted
    // `agent_messages` (the in-process SDK bus is gone). Append each once,
    // deduped by its real DB id so a reconnect replay can't double it.
    if (event.type === "message" && event.message) {
      const ui = toUiMessage(event.message);
      setMessages((prev) => {
        if (prev.some((m) => m.id === ui.id)) return prev; // already have the real row
        // A just-persisted USER message is also the one we optimistically rendered
        // (temp negative id, same text) when the local composer sent it. Swap the
        // temp id for the real row instead of appending a duplicate — dedup-by-id
        // can't match a temp id to the real one, which is why the bubble doubled.
        if (ui.role === "user") {
          const i = prev.findIndex(
            (m) => m.id < 0 && m.role === "user" && uiMessageText(m) === uiMessageText(ui)
          );
          if (i !== -1) {
            const next = prev.slice();
            next[i] = ui;
            return next;
          }
        }
        return [...prev, ui];
      });
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
    return sendText(input);
  }

  async function sendText(rawText: string) {
    const text = rawText.trim();
    if (!text || sending || composerDisabled) return;
    setInput("");
    setSending(true);
    setErrorMsg(null);

    // Optimistic user message — keyed by a temp negative id so the next
    // server refresh can swap it in without flickering.
    const tmpId = nextTmpId();
    setMessages((prev) => [
      ...prev,
      { id: tmpId, role: "user", content: [{ type: "text", text }] },
    ]);

    // If the send fails before the server confirms it persisted the message
    // (`user_message` frame / any streamed reply), drop the optimistic bubble
    // so it isn't left rendered as if it were sent, and give the text back to
    // the composer (unless the user has already started a new draft).
    let delivered = false;
    const rollback = () => {
      setMessages((prev) => prev.filter((m) => m.id !== tmpId));
      setInput((cur) => (cur.length === 0 ? text : cur));
    };

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
        rollback();
        return;
      }
      await consumeSse(res.body, (event) => {
        if (event.type === "sdk" && event.sdk) {
          delivered = true;
          mergeSdkEnvelope(event.sdk);
        } else if (event.type === "error") {
          setErrorMsg(event.error ?? "Unknown error");
          // An error before anything was delivered (e.g. "already in flight")
          // means the message never landed — roll the optimistic bubble back.
          if (!delivered) rollback();
        } else if (event.type === "user_message" && event.message) {
          // The server persisted the message; the reconciliation effect swaps
          // the tmp id for the real row on the next refresh.
          delivered = true;
        }
      });
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        // A network failure (server down, connection reset) never persisted
        // the message — the AbortError case is a deliberate stop, so keep it.
        if (!delivered) rollback();
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
          {run.thinkingLevel && (
            <span className="inline-flex items-center gap-1" title="Reasoning level">
              <Brain className="size-3" />
              <code className="font-mono">{run.thinkingLevel}</code>
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
            {segmentToolMessages(visibleMessages).map((seg) =>
              seg.kind === "tools" ? (
                <ToolGroup key={`tg-${seg.messages[0].id}`} count={seg.toolCount}>
                  {seg.messages.flatMap((m) =>
                    m.content
                      .filter((b) => b.type === "tool_use")
                      .map((b, bi) => <ToolUseBlock key={`${m.id}-${bi}`} block={b} />)
                  )}
                </ToolGroup>
              ) : seg.message.role === "system" ? (
                <SystemEventRow
                  key={seg.message.id}
                  when={seg.message.createdAt ?? new Date()}
                  kind={seg.message.systemKind ?? "info"}
                  payload={seg.message.systemPayload ?? {}}
                  content={seg.message.content}
                />
              ) : (
                <RunMessage
                  key={seg.message.id}
                  role={seg.message.role}
                  content={seg.message.content}
                />
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

      {/* Planning review card — shown when the planning agent is waiting for approval */}
      {(run.planningStage === "spec_review" || run.planningStage === "plan_review" || run.planningStage === "done") && (
        <PlanningReviewCard
          run={run}
          messages={messages}
          onStageChange={handleStageChange}
          onRequestChanges={handleRequestChanges}
        />
      )}

      {/* Composer — shown for non-done planning stages and all non-closed non-planning runs */}
      {!closed && run.planningStage !== "done" && (
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
                <Button
                  size="icon"
                  onClick={send}
                  disabled={!input.trim() || composerDisabled}
                  aria-label="Send"
                >
                  <ArrowUp className="size-4" />
                </Button>
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
      {closed && run.planningStage !== "done" && (
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

// Concatenated text of a message's text blocks — used to match a just-persisted
// user message to the optimistic bubble it should replace.
function uiMessageText(m: { content: SdkContentBlock[] }): string {
  return m.content
    .map((b) => (b.type === "text" ? (b as { text?: string }).text ?? "" : ""))
    .join("");
}

// Map a persisted server row to the UI shape. Kept module-level so both the
// initial state and the server-prop reconciliation effect produce identical
// rows.
function toUiMessage(m: MessageRow): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    // Persisted system messages store the event type inside the first
    // content block (migration 0009 wrote `[{type: <event_type>, ...payload}]`).
    // Surface it as systemKind so SystemEventRow doesn't fall through to
    // the JSON fallback for everything.
    ...(m.role === "system" ? extractSystemMeta(m.content) : {}),
  };
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
