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
  RunCommit,
  RunInput,
  RunSnapshot,
  RunStart,
  TaskSnapshot,
  ToolCallResult,
  WorkerEvent,
} from "../worker-channel/protocol";
import type { WorkerSessionCommand } from "../worker-channel/worker-session";

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
  /** Append and stream a worker event; the session assigns its durable sequence. */
  emit<T extends WorkerEvent["type"]>(
    type: T,
    payload: Extract<WorkerEvent, { type: T }>["payload"]
  ): Promise<unknown>;
  /** Invoke a tool over the channel and await the control-plane result (section 15). */
  invokeTool?(tool: string, args: unknown, callId: string): Promise<ToolCallResult>;
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

/**
 * Seam error thrown when the driver reaches worker WRITE / TOOL behavior that
 * the WebSocket transport does not yet implement. Sections 14 (semantic events)
 * and 15 (tool routing) replace the seam bodies; until then a `ws`-mode run that
 * reaches a write/tool point fails here with an explicit, greppable reason
 * rather than silently falling back to a forbidden transport.
 */
export class WorkerSeamNotWiredError extends Error {
  constructor(seam: string) {
    super(
      `worker ${seam} seam is not wired on the websocket transport yet ` +
        `(lands in plan section ${seam === "tool" ? "15" : "14"})`
    );
    this.name = "WorkerSeamNotWiredError";
  }
}

/**
 * Drive one worker run from a pushed context (plan section 13.1, boundary 11).
 *
 * Accepts either a fully-built {@link WorkerRunContext} or the minimal
 * `{ start, session }` pair (which the end-to-end harness and `run-worker.ts`
 * pass); in the latter case it builds the full context from the snapshot.
 *
 * This function owns the worker-side control flow: seed the transcript view from
 * the snapshot, start the ordered input loop that consumes `run.input` commands
 * off the channel, and drive the run's turns. The actual model turn — which
 * WRITES transcript/phase/checkpoint events and INVOKES tools — flows through the
 * seams on {@link WorkerDriverSession}. Those seams are not functional on the
 * websocket transport until sections 14 and 15 land, so a `ws`-mode run reaches
 * {@link runWorkerTurn} and stops at {@link WorkerSeamNotWiredError}. The context
 * construction and input loop below are complete and independently tested.
 */
export async function driveWorkerRun(
  input: WorkerRunContext | { start: RunStart; session: WorkerDriverSession }
): Promise<void> {
  const context: WorkerRunContext =
    "run" in input && "persona" in input
      ? (input as WorkerRunContext)
      : buildWorkerRunContext(input.start, input.session);

  const queue = new OrderedInputQueue(context.transcript);
  const inputLoop = consumeInputCommands(context, queue);

  try {
    await runWorkerTurns(context, queue);
  } finally {
    // Stop the input loop from holding the process open past run commit/drain.
    inputLoop.stop();
    await inputLoop.done.catch(() => {});
  }
}

interface InputLoopHandle {
  stop(): void;
  readonly done: Promise<void>;
}

/**
 * Consume the channel's ordered command iterator, routing `run.input` commands
 * into the {@link OrderedInputQueue}. Non-input commands (cancel / park / commit /
 * tool.result) are handled elsewhere: cancel already aborts the session's
 * abortSignal inside {@link WorkerSession}, and tool.result / run.commit resolve
 * their waiters there too, so the input loop ignores them.
 */
function consumeInputCommands(
  context: WorkerRunContext,
  queue: OrderedInputQueue
): InputLoopHandle {
  let stopped = false;
  const done = (async () => {
    for await (const command of context.session.commands()) {
      if (stopped) break;
      if (isRunInput(command)) queue.offerBatch(command);
    }
  })();
  return {
    stop() {
      stopped = true;
    },
    done,
  };
}

/**
 * Drive the run's turns from the loaded context and accepted input. The turn
 * body itself is the write/tool seam that sections 14/15 supply; see
 * {@link runWorkerTurn}.
 */
async function runWorkerTurns(
  context: WorkerRunContext,
  queue: OrderedInputQueue
): Promise<void> {
  await runWorkerTurn(context, queue);
}

/**
 * Execute a single worker turn against the loaded context.
 *
 * SEAM (plan sections 14 & 15): the model turn writes transcript/phase/checkpoint
 * events via `context.session.emit` and invokes tools via
 * `context.session.invokeTool`. Those wirings are not yet in place on the
 * websocket transport, so this seam fails fast and explicitly. The gated
 * end-to-end suite is expected to reach this point (past module resolution of
 * this file) and stop here until section 14 lands.
 */
async function runWorkerTurn(
  _context: WorkerRunContext,
  _queue: OrderedInputQueue
): Promise<void> {
  throw new WorkerSeamNotWiredError("write");
}
