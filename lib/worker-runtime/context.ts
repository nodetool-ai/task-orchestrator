// lib/worker-runtime/context.ts
//
// Worker-side run driver for the WebSocket transport (plan section 13).
//
// This module is loaded INSIDE the worker process. It must never read Postgres
// or call the control-plane HTTP API: everything the worker needs to drive a
// run arrives in the authoritative `RunStart` snapshot the control plane pushes
// over the channel, and every subsequent user input arrives as a `run.input`
// command on the same channel. The bundle guard (__tests__/worker-runtime-bundle-guard.test.ts)
// enforces the read-freedom of this directory.
//
// Worker WRITES (transcript, phase, checkpoint, finish/fail) and TOOL calls are
// deliberately routed through the small named seams on {@link WorkerDriverSession}
// below. In `ws` mode those seams are supplied by the live WorkerSession; the
// semantic-event wiring (plan section 14) and the tool routing (plan section 15)
// swap the seam implementations without touching this driver's control flow.

import type {
  MessageSnapshot,
  PersonaSnapshot,
  PlanSnapshot,
  RepositorySnapshot,
  RunCancel,
  RunCommit,
  RunInput,
  RunSnapshot,
  RunStart,
  TaskSnapshot,
  ToolCallResult,
  UsageSnapshot,
  WorkerEvent,
} from "../worker-channel/protocol";
import type { WorkerSessionCommand } from "../worker-channel/worker-session";
import { getBackend } from "../agent-backend";
import type { RunTurnArgs } from "../agent-backend/types";
import type { RunEnvelope } from "../pi-event-mapper";
import { config } from "../config";
import { parseProviderQualifiedModel } from "../model-id";
import { buildWorkerToolInvoker } from "./tools";
import { coerceRunStatus, isTerminalStatus, type SessionStatus } from "../run-state";

/**
 * Structural view of the live {@link WorkerSession} the run driver depends on.
 * Keeping it structural lets the driver accept the supervisor's `server.session`
 * directly (plan section 13.1: "The driver consumes the WorkerSession API from
 * section 7.2 directly — there is no adapter implementing RunTransport over the
 * channel") while remaining unit-testable with a lightweight double.
 */
export interface WorkerDriverSession {
  /** Ordered controller-command iterator (run.input / cancel / park / commit / tool.result). */
  commands(): AsyncIterable<WorkerSessionCommand>;
  /** Await the authoritative `RunStart` snapshot the control plane pushed. Used
   *  by {@link driveWorkerRun} when invoked without a pre-built context/start. */
  waitForStart?(): Promise<RunStart>;
  /** Append and stream a worker event; the session assigns its durable sequence
   *  and returns the persisted envelope (its `id` is the idempotency key the
   *  control plane records, and the finish-event id a commit replies to). */
  emit<T extends WorkerEvent["type"]>(
    type: T,
    payload: Extract<WorkerEvent, { type: T }>["payload"]
  ): Promise<{ id: string }>;
  /** Invoke a tool over the channel and await the control-plane result (section 15). */
  invokeTool?(tool: string, args: unknown, callId: string): Promise<ToolCallResult>;
  /** Resolve once the controller's cumulative ack covers the given worker seq —
   *  i.e. the control plane durably applied the event. Used where the driver
   *  must OBSERVE an event's effect before returning (the chat-exit idle
   *  landing); plain emits stay fire-and-forget. */
  waitForAck?(seq: number): Promise<void>;
  /** Await the control plane's terminal commit decision for a finish event. */
  waitForCommit?(finishEventId: string): Promise<RunCommit>;
  /** Aborts when the control plane cancels the run or the controller disconnects. */
  readonly abortSignal?: AbortSignal;
}

/**
 * Everything the worker driver needs to run one run, assembled from the pushed
 * `RunStart` snapshot. The driver reads these loaded objects instead of querying
 * Postgres (plan section 13.1 / 13.2).
 */
export interface WorkerRunContext {
  start: RunStart;
  session: WorkerDriverSession;
  run: RunSnapshot;
  task: TaskSnapshot | null;
  plan: PlanSnapshot | null;
  persona: PersonaSnapshot;
  repository: RepositorySnapshot;
  /**
   * The worker's transcript view. Seeded from the snapshot transcript and
   * pending input, then grown in place as accepted `run.input` commands arrive
   * (plan section 13.3).
   */
  transcript: MessageSnapshot[];
}

/**
 * Assemble a {@link WorkerRunContext} from an authoritative `RunStart` snapshot.
 *
 * Pure over the snapshot — no I/O, no reads. The transcript view is a fresh
 * mutable copy that concatenates the snapshot transcript with any pending input
 * the control plane included in the bootstrap bundle (a follow-up that arrived
 * before the worker connected), so the driver sees a single ordered history.
 */
export function buildWorkerRunContext(
  start: RunStart,
  session: WorkerDriverSession
): WorkerRunContext {
  return {
    start,
    session,
    run: start.run,
    task: start.task,
    plan: start.plan,
    persona: start.persona,
    repository: start.repository,
    transcript: [...start.transcript, ...start.pendingInput],
  };
}

export type InputOfferOutcome = "accepted" | "duplicate" | "rejected";

/**
 * In-memory ordered input queue for a run (plan section 13.3).
 *
 * Replaces the HTTP transport's `subscribeInput`. It is keyed by persisted
 * message id and enforces the channel's at-least-once, ordered-replay contract:
 *
 *   - a message id already accepted is a benign duplicate (a reconnect replay) —
 *     ignored, not re-appended;
 *   - a NON-duplicate id lower than the highest accepted id is out-of-order and
 *     rejected — the channel guarantees monotonic delivery, so a decreasing id
 *     is a protocol violation, never a legitimate late message;
 *   - otherwise the message is accepted, appended to the transcript view, and
 *     enqueued for the driver to consume on its next turn.
 */
export class OrderedInputQueue {
  private readonly transcript: MessageSnapshot[];
  private readonly seen = new Set<number>();
  private readonly pending: MessageSnapshot[] = [];
  private highest = 0;

  /**
   * @param transcript the context's transcript view; accepted inputs are
   *   appended here so the driver's next turn sees them.
   */
  constructor(transcript: MessageSnapshot[]) {
    this.transcript = transcript;
    // Seed the high-water mark and duplicate set from any pre-seeded rows so a
    // reconnect that replays already-visible pending input is a no-op.
    for (const message of transcript) {
      this.seen.add(message.id);
      if (message.id > this.highest) this.highest = message.id;
    }
  }

  /**
   * Offer a single inbound user message. Returns the classification so callers
   * (and tests) can distinguish accepted / duplicate / rejected.
   */
  offer(message: MessageSnapshot): InputOfferOutcome {
    const id = message.id;
    if (this.seen.has(id)) return "duplicate";
    if (id < this.highest) return "rejected";
    this.seen.add(id);
    this.highest = id;
    this.transcript.push(message);
    this.pending.push(message);
    return "accepted";
  }

  /**
   * Offer every message in a `run.input` command in id order, tolerating an
   * out-of-order batch by sorting first. Returns the per-message outcomes.
   */
  offerBatch(input: RunInput): InputOfferOutcome[] {
    const sorted = [...input.messages].sort((a, b) => a.id - b.id);
    return sorted.map((message) => this.offer(message));
  }

  /** Drain and return the accepted-but-not-yet-consumed inputs, in id order. */
  drain(): MessageSnapshot[] {
    const drained = this.pending.splice(0);
    return drained;
  }

  /** Whether any accepted input is waiting for the driver to consume. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Highest accepted message id — the input-processing high-water mark. */
  highWaterMark(): number {
    return this.highest;
  }
}

/**
 * A `run.input` command carries a `messages` array; the other channel commands
 * (cancel / park / commit / tool.result) do not. This structural guard lets the
 * input loop pick input commands off the single ordered command iterator.
 */
export function isRunInput(command: WorkerSessionCommand): command is RunInput {
  return Array.isArray((command as RunInput).messages);
}

// ──────────────────────────────────────────────────────────
// Channel-native turn engine (plan section 14.4)
// ──────────────────────────────────────────────────────────
//
// This is the migration's core: the worker drives the model turn(s) reading
// EVERYTHING from the pushed {@link WorkerRunContext} (never a transport read)
// and writing ONLY through `session.emit` semantic events — transcript.append,
// agent.event, run.checkpoint, and, for a single-turn run, run.finished followed
// by session.waitForCommit. Nothing here reads Postgres or the control-plane
// HTTP API; heartbeat / ackCancel / releaseClaim do not exist on this path (the
// channel and the control-plane commit handler own them).
//
// The turn machinery mirrors lib/runs.ts's `append`/`driveChatSession`: the same
// backend seam is invoked the same way, but every WRITE that `append` performs
// against the DB transport becomes a semantic event here. That duplication is
// deliberate and temporary — the legacy HTTP driver stays intact until plan
// section 18 deletes it.

/** Read a snapshot field defensively — {@link RunSnapshot} is deliberately a
 *  permissive open shape (`{ id, status?, [key]: unknown }`). */
function runField<T = unknown>(run: RunSnapshot, key: string): T | undefined {
  return (run as Record<string, unknown>)[key] as T | undefined;
}

function runGoal(run: RunSnapshot): string {
  return typeof runField(run, "goal") === "string" ? (runField(run, "goal") as string) : "";
}

function runStatus(run: RunSnapshot): SessionStatus {
  return coerceRunStatus(String(run.status ?? "running"));
}

/** Concatenated text of a message's content blocks (mirrors worker/protocol's
 *  contentText, kept local so this bundle imports no control-plane read paths). */
function contentText(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim();
}

/** User messages newer than the most recent agent reply — the turns the worker
 *  still owes a response for (matches lib/runs.ts's backlog semantics). */
function unprocessedUserMessages(transcript: MessageSnapshot[]): MessageSnapshot[] {
  let lastAgentId = 0;
  for (const m of transcript) if (m.role === "agent" && m.id > lastAgentId) lastAgentId = m.id;
  return transcript.filter((m) => m.role === "user" && m.id > lastAgentId);
}

/** A single kickoff sentinel for a resumed/woken drive with no fresh user text —
 *  the checked-out code plus prior session context carry the continuation. */
const RESUME_PROMPT = "Resume this run and continue from where the previous session left off.";

// A worker-proposed transcript row has no persisted id yet (the control plane
// assigns it and keys idempotency off the envelope id, not this value), but the
// wire schema requires a positive integer. Hand out a synthetic monotonic id.
let syntheticMessageSeq = 0;
function syntheticMessageId(): number {
  return ++syntheticMessageSeq;
}

interface TurnResult {
  summary: string | null;
  sdkSessionId: string | null;
  usage: UsageSnapshot;
}

/**
 * Run ONE model turn against the loaded context. Invokes the backend exactly as
 * lib/runs.ts does (same seam, same neutral RunEnvelope stream) and routes every
 * streamed envelope to a `session.emit` semantic event:
 *   - assistant content  → transcript.append (role "agent")
 *   - tool results        → transcript.append (role "tool")
 *   - other envelopes     → agent.event
 * The turn's abort is bridged from `session.abortSignal`, so a `run.cancel`
 * arriving mid-turn aborts the backend. The backend's tool calls are routed over
 * the channel via `session.invokeTool` (plan section 15).
 */
async function runModelTurn(
  context: WorkerRunContext,
  prompt: string
): Promise<TurnResult> {
  const { run, session } = context;

  // Bridge the session's cancel/disconnect signal onto the backend's controller.
  const abort = new AbortController();
  const signal = session.abortSignal;
  if (signal) {
    if (signal.aborted) abort.abort((signal as AbortSignal).reason);
    else signal.addEventListener("abort", () => abort.abort((signal as AbortSignal).reason), { once: true });
  }

  let summary: string | null = null;
  let lastAssistantText: string | null = null;
  let sdkSessionId: string | null = (runField(run, "sdkSessionId") as string | null | undefined) ?? null;
  const usage: UsageSnapshot = {};

  const onEvent = async (env: RunEnvelope): Promise<void> => {
    if (env.type === "system" && env.subtype === "init" && env.session_id) {
      sdkSessionId = env.session_id;
      return;
    }
    if (env.type === "assistant" && env.message?.content?.length) {
      await session.emit("transcript.append", {
        message: { id: syntheticMessageId(), role: "agent", content: env.message.content as unknown[] },
      });
      const text = contentText(env.message.content as unknown[]);
      if (text) lastAssistantText = text;
      return;
    }
    if (env.type === "user" && env.message?.content?.length) {
      await session.emit("transcript.append", {
        message: { id: syntheticMessageId(), role: "tool", content: env.message.content as unknown[] },
      });
      return;
    }
    if (env.type === "result") {
      if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
      if (typeof env.usage?.input_tokens === "number") usage.inputTokens = env.usage.input_tokens;
      if (typeof env.usage?.output_tokens === "number") usage.outputTokens = env.usage.output_tokens;
      if (typeof env.total_cost_usd === "number") usage.totalCostUsd = env.total_cost_usd;
      return;
    }
    // Everything else (stream deltas, diagnostics) is a structured agent event.
    await session.emit("agent.event", { event: env });
  };

  const backend = await getBackend((runField(run, "backend") as string | null | undefined) ?? null);
  // The run row stores the picker's "provider/model-id" form; backends expect
  // it split (a bare id defaults to anthropic) — same rule as lib/runs.ts.
  const rawModel = (runField(run, "model") as string | undefined) ?? config.agent.model ?? "";
  const { provider: resolvedProvider, id: resolvedModel } = parseProviderQualifiedModel(rawModel);

  // Tool extensions (plan section 15): mount the run's tools profile with the
  // CHANNEL invoker, so task_orch__*/spawn__*/events__* tools execute on the
  // control plane via tool.invoke. Without this the agent gets only the
  // backend's built-ins and cannot orchestrate (no spawn, no task
  // transitions). The profile registry is shared with the legacy path; the
  // ws driver supplies invoke + the snapshot-resolved repo remote so no
  // factory ever touches a transport here.
  const invoke = session.invokeTool
    ? buildWorkerToolInvoker(context.start, { invokeTool: (t, a, c) => session.invokeTool!(t, a, c) })
    : undefined;
  // Turn cwd: the run's prepared checkout when one exists, else the resolved
  // repository's working copy from the snapshot. Never fall back to
  // process.cwd() — a local worker's cwd is the ORCHESTRATOR checkout, and an
  // agent turned loose there is exploring the wrong codebase.
  const cwd =
    (runField(run, "worktreePath") as string | undefined) ??
    (typeof context.repository?.localPath === "string" ? context.repository.localPath : undefined) ??
    process.cwd();
  const profileCtx = {
    runId: (runField(run, "id") as number) ?? 0,
    run: run as never,
    author: runGoal(run) === "<chat>" ? "chat" : "claude-agent",
    taskId: (runField(run, "taskId") as string | null) ?? null,
    planId: (runField(run, "planId") as string | null) ?? null,
    cwd,
    invoke,
    repoRemote: (typeof context.repository?.remote === "string" ? context.repository.remote : null),
  };
  const { resolveProfiles, alwaysOnExtensions } = await import("../profiles");
  const profileSpec =
    (runField(run, "toolsProfile") as string | undefined) ||
    (context.persona as { toolsProfile?: string }).toolsProfile ||
    "";
  const extensions = [
    ...(profileSpec ? (await resolveProfiles(profileSpec, profileCtx)).factories : []),
    ...(await alwaysOnExtensions(profileCtx)),
  ];

  const turnArgs: RunTurnArgs & {
    abortSignal?: AbortSignal;
    invokeTool?: (tool: string, args: unknown, callId: string) => Promise<ToolCallResult>;
  } = {
    cwd,
    model: { provider: resolvedProvider, id: resolvedModel },
    thinkingLevel: (runField(run, "thinkingLevel") as RunTurnArgs["thinkingLevel"]) ?? undefined,
    extensions,
    resumeToken: sdkSessionId,
    abort,
    prompt,
    onEvent,
    // Extra fields the channel turn exposes to the backend (not part of the
    // legacy RunTurnArgs surface): the live cancel signal and the tool router.
    // The router forwards straight to the channel; the control plane is the
    // authority on the start policy (plan section 15 rule 2) and rejects any
    // unauthorized tool. The worker-local catalogue gate lives in
    // lib/worker-runtime/tools.ts, which decides which tools are REGISTERED to
    // the backend in the first place (it must not pre-empt a live channel call).
    abortSignal: signal,
    invokeTool: session.invokeTool
      ? (tool, args, callId) => session.invokeTool!(tool, args, callId)
      : undefined,
  };

  const outcome = await backend.runTurn(turnArgs);
  return {
    summary: summary ?? lastAssistantText ?? outcome.summary,
    sdkSessionId: outcome.resumeToken ?? sdkSessionId,
    usage,
  };
}

/** Emit a checkpoint carrying the backend resume id and this turn's usage so a
 *  reconnect/resume rebuilds from the latest SDK session and counters. */
async function emitCheckpoint(context: WorkerRunContext, turn: TurnResult): Promise<void> {
  await context.session.emit("run.checkpoint", {
    sdkSessionId: turn.sdkSessionId,
    metadata: { ...turn.usage },
  });
}

/**
 * Drive one worker run from a pushed context (plan sections 13.1 / 14.4).
 *
 * Accepts a fully-built {@link WorkerRunContext}, the minimal `{ start, session }`
 * pair, or `{ session }` alone. Without a start snapshot it awaits
 * `session.waitForStart()` first (a gated-e2e case, and `run-worker.ts`, hit this
 * form). A missing start snapshot marks the drive as INPUT-DRIVEN: after the
 * initial turn it waits (bounded by the chat idle timeout) for a follow-up
 * `run.input` command and drains it, mirroring the legacy chat loop's wake.
 */
export async function driveWorkerRun(
  input: WorkerRunContext | { start?: RunStart; session: WorkerDriverSession }
): Promise<void> {
  let context: WorkerRunContext;
  let inputDriven: boolean;
  if ("run" in input && "persona" in input) {
    context = input;
    inputDriven = false;
  } else if (input.start != null) {
    context = buildWorkerRunContext(input.start, input.session);
    inputDriven = false;
  } else {
    if (!input.session.waitForStart) {
      throw new Error("driveWorkerRun was invoked without a start snapshot and no waitForStart seam");
    }
    const start = await input.session.waitForStart();
    context = buildWorkerRunContext(start, input.session);
    inputDriven = true;
  }

  if (runGoal(context.run) === "<chat>") {
    await driveChatRun(context, inputDriven);
  } else {
    // The control plane claims the run into "preparing" at dispatch time; this
    // is the channel-native equivalent of the legacy setStatus("running") call
    // (lib/runs.ts) — the driver has its snapshot and is about to run a turn.
    // The terminal outcome (run.finished/failed/cancelled) supersedes it.
    // Fire-and-forget: order is preserved by the session's serial send queue.
    void context.session.emit("run.phase", { phase: "running" }).catch(() => undefined);
    await driveSingleTurn(context);
  }
}

interface InputLoopHandle {
  stop(): void;
  readonly done: Promise<void>;
  /** requestId of the most recent `run.cancel` command, for run.cancelled. */
  cancelRequestId(): string;
}

/**
 * Consume the channel's ordered command iterator, routing `run.input` commands
 * into the {@link OrderedInputQueue} and waking the drive loop on each accepted
 * batch. `run.cancel` already aborts the session's abortSignal inside the
 * WorkerSession; here we only capture its requestId for the eventual
 * run.cancelled event. tool.result / run.commit resolve their waiters in the
 * session, so the loop ignores them.
 */
function consumeInputCommands(
  context: WorkerRunContext,
  queue: OrderedInputQueue,
  onWake: () => void
): InputLoopHandle {
  let stopped = false;
  let lastCancelRequestId = "";
  // Kept floating on purpose: the live session iterator only ends on session
  // close. Swallow its settlement so a parked/aborted iterator never surfaces as
  // an unhandled rejection after the drive has already returned.
  const done = (async () => {
    for await (const command of context.session.commands()) {
      if (stopped) break;
      if (isRunInput(command)) {
        const outcomes = queue.offerBatch(command);
        if (outcomes.some((o) => o === "accepted")) onWake();
      } else if (isRunCancel(command)) {
        lastCancelRequestId = command.requestId;
        onWake();
      }
    }
  })();
  done.catch(() => {});
  return {
    stop() {
      stopped = true;
    },
    done,
    cancelRequestId: () => lastCancelRequestId,
  };
}

/** A `run.cancel` command carries a `requestId`; the input guard already claims
 *  the `messages` shape, so this narrows the remaining cancel command. */
function isRunCancel(command: WorkerSessionCommand): command is RunCancel {
  return typeof (command as RunCancel).requestId === "string" && !isRunInput(command);
}

/**
 * Drive a `<chat>` run: process the pending user turn(s) from the snapshot, then
 * — on an input-driven drive — wait once (bounded by the chat idle timeout) for a
 * follow-up `run.input` and process it. A chat turn writes transcript/agent/
 * checkpoint events but NEVER a terminal outcome: the run stays resumable-idle,
 * landed by the control plane, not by the worker.
 */
async function driveChatRun(context: WorkerRunContext, inputDriven: boolean): Promise<void> {
  const { run, session } = context;

  // A run that already carries `completedAt` is a prior worker's finished
  // lifecycle: this invocation is the stranded-message check the legacy
  // releaseClaim performed on chat exit, not a fresh turn. Do not run a turn;
  // re-dispatch a stranded non-terminal run so a fresh worker resumes it.
  if (runField(run, "completedAt") != null) {
    await redispatchIfStranded(context);
    return;
  }

  const queue = new OrderedInputQueue(context.transcript);
  let wake: (() => void) | null = null;
  const inputLoop = consumeInputCommands(context, queue, () => {
    wake?.();
    wake = null;
  });

  try {
    // Chat lifecycle bracket: 'running' while turns execute, restored to the
    // resumable 'idle' on clean exit below — the channel-native equivalent of
    // the legacy chat loop's setStatus("running") + releaseClaim(..., idle).
    // Fire-and-forget: the session's serial send queue preserves event order,
    // and awaiting here would only widen the window in which a racing
    // run.cancel is classified as "before the turn" instead of mid-turn.
    void session.emit("run.phase", { phase: "running" }).catch(() => undefined);
    // Never START a turn on an already-aborted session — a backend that
    // subscribes to the abort event after the fact would hang forever, and a
    // real model process would be spawned only to be torn down.
    if (session.abortSignal?.aborted) throw new Error("run cancelled before first turn");
    const seed = unprocessedUserMessages(context.transcript);
    if (seed.length > 0) {
      for (const m of seed) {
        if (session.abortSignal?.aborted) break;
        await runModelTurn(context, contentText(m.content) || RESUME_PROMPT).then((t) =>
          emitCheckpoint(context, t)
        );
      }
    } else {
      // The run.start snapshot is itself the signal to act; a chat drive with no
      // pending user message runs one kickoff/resume turn.
      const t = await runModelTurn(context, RESUME_PROMPT);
      await emitCheckpoint(context, t);
    }

    if (inputDriven) {
      // Wait (bounded by the chat idle timeout) for the first follow-up
      // `run.input`, process it, then exit — the control plane redispatches a
      // fresh worker for any later input, mirroring the legacy chat loop's
      // release-and-redispatch on exit.
      const idleMs = config.agent.chatIdleMs;
      for (;;) {
        if (session.abortSignal?.aborted) break;
        if (queue.hasPending()) {
          await drainAndProcess(context, queue);
          break;
        }
        const woke = await waitForWake(idleMs, session.abortSignal, (resume) => {
          wake = resume;
        });
        wake = null;
        if (!woke) break; // idle timeout, no follow-up arrived
      }
    } else {
      // Single drive: process any input already queued alongside the seed, then
      // return without waiting for future input.
      await drainAndProcess(context, queue);
    }
  } catch (err) {
    if (session.abortSignal?.aborted) {
      await emitCancelled(context, inputLoop.cancelRequestId());
      return;
    }
    throw err;
  } finally {
    // Stop routing new commands into the queue. The underlying `for await` over
    // the live session iterator stays parked until the session closes (on worker
    // drain); do NOT await it here or the drive would never return.
    inputLoop.stop();
  }

  // A cancel that landed after the turn(s) completed still owes a run.cancelled.
  if (session.abortSignal?.aborted) {
    await emitCancelled(context, inputLoop.cancelRequestId());
    return;
  }
  // Clean chat exit: the run stays resumable — land it back on 'idle' exactly
  // as the legacy releaseClaim(..., idle) chat-exit path did. Await the
  // controller's ack so the landing is observable before the drive returns
  // (emit alone is only spool-durable).
  const idlePhase = (await session.emit("run.phase", { phase: "idle" })) as { id: string; seq?: number };
  if (session.waitForAck && typeof idlePhase.seq === "number") {
    await session.waitForAck(idlePhase.seq);
  }
}

/** Persist and run a turn for each accepted-but-unconsumed input message. Unlike
 *  the snapshot seed (already persisted), a `run.input` message is appended over
 *  the channel via transcript.append before its turn runs. */
async function drainAndProcess(context: WorkerRunContext, queue: OrderedInputQueue): Promise<void> {
  for (const m of queue.drain()) {
    if (context.session.abortSignal?.aborted) return;
    await context.session.emit("transcript.append", {
      message: { id: m.id, role: "user", content: m.content },
    });
    const t = await runModelTurn(context, contentText(m.content) || RESUME_PROMPT);
    await emitCheckpoint(context, t);
  }
}

/**
 * Drive a single-turn run (`<implement>` / `<execute>` / `<review>` / resume):
 * run ONE turn, then propose the terminal outcome and await the control plane's
 * commit. The control plane — never the worker — lands the terminal status.
 */
async function driveSingleTurn(context: WorkerRunContext): Promise<void> {
  const { session } = context;
  // Fresh starts lead with the control plane's goal-synthesized kickoff
  // prompt (execute scaffold / implement task prompt / free-form goal); any
  // persisted user backlog (e.g. an operator initialPrompt) follows it as
  // steering, mirroring the legacy "operator instructions" ordering.
  const backlog = unprocessedUserMessages(context.transcript)
    .map((m) => contentText(m.content))
    .filter(Boolean);
  const kickoff = context.start.kickoffPrompt?.trim();
  const backlogText = backlog.join("\n\n");
  const prompt = kickoff
    ? backlogText
      ? `${kickoff}\n\n## Operator instructions\n\n${backlogText}`
      : kickoff
    : backlogText || RESUME_PROMPT;

  let turn: TurnResult;
  try {
    // Same pre-check as the chat path: a session aborted before the turn
    // starts must short-circuit to run.cancelled, never invoke the backend.
    if (session.abortSignal?.aborted) throw new Error("run cancelled before turn");
    turn = await runModelTurn(context, prompt);
  } catch (err) {
    if (session.abortSignal?.aborted) {
      await emitCancelled(context, "");
      return;
    }
    const fin = await session.emit("run.failed", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    await awaitCommit(session, fin.id);
    return;
  }

  if (session.abortSignal?.aborted) {
    await emitCancelled(context, "");
    return;
  }

  await emitCheckpoint(context, turn);
  const fin = await session.emit("run.finished", {
    result: turn.summary,
    usage: turn.usage,
  });
  await awaitCommit(session, fin.id);
}

/** Emit run.cancelled and await its commit. Guards against a closed session (a
 *  disconnect grace expiry can close it before the commit round-trips). */
async function emitCancelled(context: WorkerRunContext, requestId: string): Promise<void> {
  const reason = ((context.session.abortSignal as AbortSignal | undefined)?.reason);
  try {
    const fin = await context.session.emit("run.cancelled", {
      // A single-turn drive has no command-loop tracking the cancel request id;
      // the protocol requires a non-empty requestId, and the control plane keys
      // the terminal landing off the finish-event id (not this value), so a
      // sentinel is safe when the real request id is unknown.
      requestId: requestId || "cancel",
      reason: typeof reason === "string" ? reason : undefined,
    });
    await awaitCommit(context.session, fin.id);
  } catch {
    // A closed/aborted session cannot round-trip a commit; the control plane's
    // disconnect handler lands the terminal outcome instead.
  }
}

async function awaitCommit(session: WorkerDriverSession, finishEventId: string): Promise<void> {
  if (!session.waitForCommit) return;
  try {
    await session.waitForCommit(finishEventId);
  } catch {
    // Session closed before the commit arrived; the control plane still lands
    // the outcome durably from the received terminal event.
  }
}

/**
 * Re-dispatch a run whose chat worker exited leaving a non-empty user message
 * unprocessed (the legacy releaseClaim stranded-message drain, plan 14.4 item 7).
 * A terminal run is never resurrected. This is the sole control-plane call on
 * this path and, like the legacy transport's own redispatch, runs where the
 * driver executes; the channel's disconnect handler owns it in production.
 */
async function redispatchIfStranded(context: WorkerRunContext): Promise<void> {
  const { run } = context;
  if (isTerminalStatus(runStatus(run))) return;
  const stranded = unprocessedUserMessages(context.transcript).some((m) => contentText(m.content) !== "");
  if (!stranded) return;
  const dispatch = await import("../run-dispatch");
  await dispatch.dispatchRun(run.id);
}

/** Resolve true on a wake, false on the idle timeout; also resolves (true) when
 *  the abort signal fires so a cancel unblocks the idle wait promptly. */
function waitForWake(
  idleMs: number,
  signal: AbortSignal | undefined,
  register: (resume: () => void) => void
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), idleMs);
    const onAbort = () => finish(true);
    function finish(woke: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(woke);
    }
    register(() => finish(true));
    if (signal) {
      if (signal.aborted) finish(true);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
