// The store drives every subscription and timer in the cockpit, so it is
// tested headless: a stub client, an injected clock, no renderer and no sleeps.

import { describe, expect, it } from "vitest";
import { UnauthorizedError, type OrchClient, type OverviewHandlers, type RunEventHandlers, type Subscription } from "../src/api/client.js";
import type {
  CreateRunInput,
  GlobalInboxRow,
  MessageRow,
  PersonaSummary,
  PlanSummary,
  ProvidersResponse,
  RunConfigInput,
  RunDetail,
  RunIndexRow,
  RunRow,
  StreamCursor,
  TaskSummary,
} from "../src/api/types.js";
import { createStore, type Clock } from "../src/store.js";

class TestClock implements Clock {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimer(h: unknown): void {
    this.timers.delete(h as number);
  }
  get pending(): number {
    return this.timers.size;
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.t = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.t = end;
  }
}

/** Let every already-resolved promise chain settle. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function row(id: number, over: Partial<RunIndexRow> = {}): RunIndexRow {
  return {
    id,
    goal: `goal ${id}`,
    status: "running",
    origin: "chat",
    title: `run ${id}`,
    taskId: null,
    taskTitle: null,
    planId: null,
    planTitle: null,
    repoId: null,
    repoName: null,
    parentRunId: null,
    prUrl: null,
    model: null,
    budgetMaxUsd: null,
    budgetMaxTurns: null,
    totalCostUsd: 0,
    error: null,
    startedAt: new Date(0).toISOString(),
    completedAt: null,
    parkReason: null,
    pendingReason: null,
    pendingEvents: 0,
    personaId: "concierge",
    personaName: "concierge",
    ...over,
  };
}

function message(id: number, runId: number, text: string): MessageRow {
  return { id, runId, role: "agent", content: [{ type: "text", text }], createdAt: new Date(id * 1000).toISOString() };
}

function runRow(id: number, goal: string, status: RunRow["status"] = "running"): RunRow {
  return {
    id,
    goal,
    status,
    title: null,
    personaId: "concierge",
    parentRunId: null,
    model: null,
    budgetMaxUsd: null,
    budgetMaxTurns: null,
    taskId: null,
    planId: null,
    prUrl: null,
    totalCostUsd: 0,
    startedAt: new Date(0).toISOString(),
    completedAt: null,
  };
}

function persona(id: string, over: Partial<PersonaSummary> = {}): PersonaSummary {
  return {
    id,
    name: id,
    description: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    toolsProfile: null,
    backend: null,
    budgetMaxTurns: null,
    budgetMaxSeconds: null,
    ...over,
  };
}

function inboxRow(id: string, runId: number, kind: GlobalInboxRow["kind"], at: number): GlobalInboxRow {
  return {
    id,
    runId,
    kind,
    text: `${kind} on ${runId}`,
    createdAt: new Date(at).toISOString(),
    personaId: "concierge",
    personaName: "concierge",
    runTitle: null,
    type: kind,
    prUrl: null,
  };
}

interface RunSub extends Subscription {
  id: number;
  cursor: StreamCursor;
  handlers: RunEventHandlers;
  closed: boolean;
}

class StubClient implements OrchClient {
  rows: RunIndexRow[] = [row(1)];
  messages: Record<number, MessageRow[]> = {};
  inboxRows: GlobalInboxRow[] = [];
  taskRows: TaskSummary[] = [];
  planRows: PlanSummary[] = [];
  overviewCalls = 0;
  tasksCalls = 0;
  plansCalls = 0;
  inboxCalls = 0;
  personaRows: PersonaSummary[] = [];
  personasCalls = 0;
  providerRows: ProvidersResponse | null = null;
  providersCalls = 0;
  sent: Array<{ id: number; text: string }> = [];
  created: CreateRunInput[] = [];
  cancelled: number[] = [];
  configured: Array<{ id: number; patch: RunConfigInput }> = [];
  configureError: unknown = null;
  sendError: unknown = null;
  createError: unknown = null;
  cancelError: unknown = null;
  /** While true, sendMessage hangs until releaseSend() — so a test can look at
   *  the transcript while the POST is still in flight. */
  sendBlocked = false;
  private release: (() => void) | null = null;
  nextRunId = 100;
  overviewError: unknown = null;
  overviewHandlers: OverviewHandlers | null = null;
  overviewClosed = false;
  runSubs: RunSub[] = [];

  async overview(): Promise<RunIndexRow[]> {
    this.overviewCalls++;
    if (this.overviewError) throw this.overviewError;
    return this.rows;
  }
  listRuns(): Promise<RunIndexRow[]> {
    return this.overview();
  }
  async run(id: number): Promise<RunDetail> {
    return { messages: this.messages[id] ?? [] } as RunDetail;
  }
  async runInbox(): Promise<never> {
    throw new Error("unused");
  }
  async inbox(): Promise<GlobalInboxRow[]> {
    this.inboxCalls++;
    return this.inboxRows;
  }
  async tasks(): Promise<TaskSummary[]> {
    this.tasksCalls++;
    return this.taskRows;
  }
  async plans(): Promise<PlanSummary[]> {
    this.plansCalls++;
    return this.planRows;
  }
  async personas(): Promise<PersonaSummary[]> {
    this.personasCalls++;
    return this.personaRows;
  }
  async providers(): Promise<ProvidersResponse> {
    this.providersCalls++;
    if (this.providerRows === null) throw new Error("no catalog");
    return this.providerRows;
  }
  releaseSend(): void {
    this.sendBlocked = false;
    this.release?.();
    this.release = null;
  }
  async sendMessage(id: number, text: string): Promise<void> {
    if (this.sendBlocked) await new Promise<void>((r) => (this.release = r));
    if (this.sendError) throw this.sendError;
    this.sent.push({ id, text });
  }
  async createRun(input: CreateRunInput): Promise<RunRow> {
    this.created.push(input);
    if (this.createError) throw this.createError;
    const id = this.nextRunId++;
    this.rows = [...this.rows, row(id, { personaId: input.personaId ?? null })];
    return runRow(id, input.goal);
  }
  async cancelRun(id: number): Promise<RunRow> {
    this.cancelled.push(id);
    if (this.cancelError) throw this.cancelError;
    return runRow(id, `goal ${id}`, "cancelled");
  }
  async configureRun(id: number, patch: RunConfigInput): Promise<RunRow> {
    this.configured.push({ id, patch });
    if (this.configureError) throw this.configureError;
    return {
      ...runRow(id, `goal ${id}`),
      model: patch.model === undefined ? null : patch.model,
      budgetMaxUsd: patch.budgetMaxUsd === undefined ? null : patch.budgetMaxUsd,
      budgetMaxTurns: patch.budgetMaxTurns === undefined ? null : patch.budgetMaxTurns,
    };
  }
  overviewEvents(h: OverviewHandlers): Subscription {
    this.overviewHandlers = h;
    return {
      close: () => {
        this.overviewClosed = true;
      },
    };
  }
  runEvents(id: number, cursor: StreamCursor, h: RunEventHandlers): Subscription {
    const sub: RunSub = {
      id,
      cursor,
      handlers: h,
      closed: false,
      close() {
        sub.closed = true;
      },
    };
    this.runSubs.push(sub);
    return sub;
  }
}

function boot(client: StubClient, opts: Parameters<typeof createStore>[1] = {}) {
  const clock = new TestClock();
  const store = createStore(client, { clock, autoSelect: false, ...opts });
  return { clock, store };
}

describe("store", () => {
  it("paints from overview() and rebuilds the forest on a rows frame", async () => {
    const client = new StubClient();
    client.rows = [row(1), row(2, { parentRunId: 1 })];
    const { store } = boot(client);
    await flush();

    expect(client.overviewCalls).toBe(1);
    expect(store.getState().status).toBe("live");
    expect(store.getState().forest.runs.map((r) => r.id)).toEqual([1, 2]);

    client.overviewHandlers!.onRows([row(1), row(2, { parentRunId: 1 }), row(3)]);
    expect(store.getState().forest.runs.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(store.getState().forest.childrenOf(1).map((r) => r.id)).toEqual([2]);
    store.stop();
  });

  it("tears down the previous run's stream when the current run changes", async () => {
    const client = new StubClient();
    client.messages = { 1: [message(1, 1, "one")], 2: [message(9, 2, "two")] };
    const { store } = boot(client);
    await flush();

    store.actions.select(1);
    await flush();
    const first = client.runSubs[0];
    expect(first.id).toBe(1);
    expect(first.cursor.msgId).toBe(1); // resumes past the batch

    store.actions.select(2);
    await flush();
    expect(first.closed).toBe(true);
    expect(client.runSubs).toHaveLength(2);

    // A frame already in flight on the old stream must not land in the new
    // transcript.
    first.handlers.onMessage(message(2, 1, "late"));
    const texts = store.getState().frames.map((f) => ("text" in f ? f.text : ""));
    expect(texts).toEqual(["two"]);
    store.stop();
  });

  it("appends live frames after the batch, in order", async () => {
    const client = new StubClient();
    client.messages = { 1: [message(1, 1, "first"), message(2, 1, "second")] };
    const { store } = boot(client);
    await flush();

    store.actions.select(1);
    await flush();
    expect(store.getState().frames.map((f) => ("text" in f ? f.text : ""))).toEqual(["first", "second"]);
    expect(store.getState().loading).toBe(false);

    client.runSubs[0].handlers.onMessage(message(3, 1, "third"));
    client.runSubs[0].handlers.onEvent({ type: "status", status: "completed" });
    expect(store.getState().frames.map((f) => ("text" in f ? f.text : ""))).toEqual([
      "first",
      "second",
      "third",
      "completed",
    ]);
    store.stop();
  });

  it("falls back to polling when the overview stream ends with _eos", async () => {
    const client = new StubClient();
    const { clock, store } = boot(client, { pollMs: 5000 });
    await flush();
    expect(client.overviewCalls).toBe(1);

    client.overviewHandlers!.onEnd!();
    await flush();
    expect(client.overviewCalls).toBe(2); // an immediate catch-up fetch

    clock.advance(5000);
    await flush();
    expect(client.overviewCalls).toBe(3);
    expect(store.getState().status).toBe("live");
    expect(store.getState().error).toMatch(/polling/);

    // …and the poll stops with the store.
    store.stop();
    clock.advance(20_000);
    await flush();
    expect(client.overviewCalls).toBe(3);
  });

  it("shows the one-line remedy on an UnauthorizedError", async () => {
    const client = new StubClient();
    client.overviewError = new UnauthorizedError(null);
    const { store } = boot(client);
    await flush();

    expect(store.getState().status).toBe("unauthorized");
    expect(store.getState().error).toBe(new UnauthorizedError(null).hint);
    expect(store.getState().error).toMatch(/ORCH_TOKEN/);
    store.stop();
  });

  it("caches tasks and plans for 30 s", async () => {
    const client = new StubClient();
    client.taskRows = [{ id: "T-1", title: "one", state: "todo", planId: "P-1", prUrl: null }];
    const { clock, store } = boot(client, { cacheMs: 30_000 });
    await flush();
    expect(client.tasksCalls).toBe(1);
    expect(store.getState().palette.some((p) => p.id === "T-1")).toBe(true);

    clock.advance(29_000);
    store.actions.ensurePalette();
    await flush();
    expect(client.tasksCalls).toBe(1);
    expect(client.plansCalls).toBe(1);

    clock.advance(2000);
    store.actions.ensurePalette();
    await flush();
    expect(client.tasksCalls).toBe(2);
    store.stop();
  });

  it("resolves a task to its newest attached run from the forest", async () => {
    const client = new StubClient();
    client.rows = [row(7, { taskId: "T-5" }), row(9, { taskId: "T-5" }), row(8, { taskId: "T-6" })];
    const { store } = boot(client);
    await flush();

    expect(store.actions.runForTask("T-5")).toBe(9);
    expect(store.actions.runForTask("T-9")).toBe(null);
    store.stop();
  });

  it("refreshes the inbox when the overview changes, not on every frame", async () => {
    const client = new StubClient();
    const { clock, store } = boot(client, { inboxGapMs: 1000 });
    await flush();
    expect(client.inboxCalls).toBe(1);

    // Identical rows: nothing moved, so nothing is refetched.
    client.overviewHandlers!.onRows([row(1)]);
    clock.advance(5000);
    await flush();
    expect(client.inboxCalls).toBe(1);

    client.overviewHandlers!.onRows([row(1, { status: "parked", parkReason: "question", pendingEvents: 1 })]);
    clock.advance(1000);
    await flush();
    expect(client.inboxCalls).toBe(2);
    store.stop();
  });

  it("stop() leaves nothing scheduled and closes every subscription", async () => {
    const client = new StubClient();
    client.messages = { 1: [message(1, 1, "hi")] };
    const { clock, store } = boot(client);
    await flush();
    store.actions.select(1);
    await flush();
    expect(clock.pending).toBeGreaterThan(0);

    store.stop();
    expect(clock.pending).toBe(0);
    expect(client.overviewClosed).toBe(true);
    expect(client.runSubs.every((s) => s.closed)).toBe(true);

    const before = { overview: client.overviewCalls, inbox: client.inboxCalls, tasks: client.tasksCalls };
    clock.advance(120_000);
    await flush();
    expect(client.overviewCalls).toBe(before.overview);
    expect(client.inboxCalls).toBe(before.inbox);
    expect(client.tasksCalls).toBe(before.tasks);
    store.stop(); // idempotent
  });
  // ── writes (T-tui-06/07) ────────────────────────────────────────────────

  it("shows the typed line before the POST settles, and folds the stream's echo into it", async () => {
    const client = new StubClient();
    client.sendBlocked = true;
    const { store } = boot(client);
    await flush();
    store.actions.select(1);
    await flush();

    const sending = store.actions.send("ship it");
    await flush();
    // The operator sees their own line immediately; the request is still open.
    expect(store.getState().frames).toEqual([{ kind: "user", at: 0, text: "ship it" }]);
    expect(client.sent).toEqual([]);

    client.releaseSend();
    await sending;
    expect(client.sent).toEqual([{ id: 1, text: "ship it" }]);

    // The server replays the same message on the stream: still one frame.
    client.runSubs[0].handlers.onMessage({
      id: 5,
      runId: 1,
      role: "user",
      content: [{ type: "text", text: "ship it" }],
      createdAt: new Date(5000).toISOString(),
    });
    expect(store.getState().frames).toHaveLength(1);
    store.stop();
  });

  it("leaves one actionable line when a send fails, and keeps taking messages", async () => {
    const client = new StubClient();
    client.sendError = new Error("connect ECONNREFUSED");
    const { store } = boot(client);
    await flush();
    store.actions.select(1);
    await flush();

    await store.actions.send("first"); // resolves; never throws
    expect(store.getState().error).toBe("send to #1 failed: connect ECONNREFUSED");
    expect(store.getState().status).not.toBe("unauthorized");

    client.sendError = null;
    await store.actions.send("second");
    expect(client.sent).toEqual([{ id: 1, text: "second" }]);
    store.stop();
  });

  it("flips to unauthorized when a write is rejected with 401", async () => {
    const client = new StubClient();
    client.sendError = new UnauthorizedError(null);
    const { store } = boot(client);
    await flush();
    store.actions.select(1);
    await flush();

    await store.actions.send("hi");
    expect(store.getState().status).toBe("unauthorized");
    expect(store.getState().error).toMatch(/ORCH_TOKEN/);
    store.stop();
  });

  it("settles the open question and refreshes the inbox when a send is aimed at a run", async () => {
    const client = new StubClient();
    const { store } = boot(client, { inboxGapMs: 0 });
    await flush();
    store.actions.select(1);
    await flush();
    expect(client.inboxCalls).toBe(1);

    client.runSubs[0].handlers.onEvent({ type: "child.question", question: "pi or claude?", run_id: 5 });
    expect(store.getState().frames).toEqual([{ kind: "question", at: 0, run: 5, text: "pi or claude?" }]);

    await store.actions.send("pi", 5);
    await flush();

    expect(client.sent).toEqual([{ id: 5, text: "pi" }]);
    // The question settles in place — no second copy of it — and the answer is
    // in the transcript as the operator's own line.
    expect(store.getState().frames).toEqual([
      { kind: "question", at: 0, run: 5, text: "pi or claude?", answered: "pi" },
      { kind: "user", at: 0, text: "pi", to: 5 },
    ]);
    expect(client.inboxCalls).toBe(2); // the ⚑ count has to drop now, not in 30 s
    store.stop();
  });

  it("creates a run with the persona's budget defaults and opens it", async () => {
    const client = new StubClient();
    client.personaRows = [persona("qa", { budgetMaxTurns: 40, budgetMaxSeconds: 900 }), persona("planner")];
    const { store } = boot(client);
    await flush();
    store.actions.ensurePersonas();
    await flush();

    const id = await store.actions.newRun("qa", "verify the cockpit");
    await flush();

    expect(client.created).toEqual([
      {
        goal: "verify the cockpit",
        personaId: "qa",
        // Deliberate: a worktree run with no taskId is rejected server-side.
        cwdStrategy: "none",
        budget: { maxTurns: 40, maxSeconds: 900 },
      },
    ]);
    expect(id).toBe(100);
    expect(store.getState().current).toBe(100);

    // A persona with no budget columns sends no budget key at all.
    await store.actions.newRun("planner", "plan it");
    await flush();
    expect(client.created[1]).toEqual({ goal: "plan it", personaId: "planner", cwdStrategy: "none" });
    store.stop();
  });

  it("reports a failed create instead of throwing, and stays on the current run", async () => {
    const client = new StubClient();
    client.createError = new Error("unknown persona");
    const { store } = boot(client);
    await flush();
    store.actions.select(1);
    await flush();

    expect(await store.actions.newRun("nope", "goal")).toBe(null);
    expect(store.getState().error).toBe("new nope run failed: unknown persona");
    expect(store.getState().current).toBe(1);
    store.stop();
  });

  it("cancels a run and refreshes the needs-you list", async () => {
    const client = new StubClient();
    const { store } = boot(client, { inboxGapMs: 0 });
    await flush();

    await store.actions.cancelRun(1);
    await flush();
    expect(client.cancelled).toEqual([1]);
    expect(client.inboxCalls).toBe(2);

    client.cancelError = new Error("Not found");
    await store.actions.cancelRun(99);
    expect(store.getState().error).toBe("cancel #99 failed: Not found");
    store.stop();
  });

  // The overview stream wakes on agent_events/agent_messages inserts, and a
  // bare column update writes neither — so the confirmed values have to be
  // folded in here or the header would lag by up to the stream's safety
  // refetch, which is exactly what `/model` and `/budget` are judged on.
  it("shows a configured model and budget before the next snapshot arrives", async () => {
    const client = new StubClient();
    const { store } = boot(client);
    await flush();

    expect(await store.actions.configureRun(1, { model: "sonnet", budgetMaxUsd: 5 })).toBe(true);
    await flush();
    expect(client.configured).toEqual([{ id: 1, patch: { model: "sonnet", budgetMaxUsd: 5 } }]);
    const run = store.getState().forest.byId(1);
    expect(run?.model).toBe("sonnet");
    expect(run?.budgetUsd).toBe(5);

    // A stale snapshot must not undo it; the row that finally carries the new
    // values retires the override.
    client.overviewHandlers?.onRows([row(1)]);
    expect(store.getState().forest.byId(1)?.model).toBe("sonnet");
    client.overviewHandlers?.onRows([row(1, { model: "sonnet", budgetMaxUsd: 5 })]);
    expect(store.getState().forest.byId(1)?.model).toBe("sonnet");
    client.overviewHandlers?.onRows([row(1, { model: "opus" })]);
    expect(store.getState().forest.byId(1)?.model).toBe("opus");
    store.stop();
  });

  it("reports a refused configure as one line and never throws", async () => {
    const client = new StubClient();
    client.configureError = new Error("Bad configure: model expected string");
    const { store } = boot(client);
    await flush();

    expect(await store.actions.configureRun(1, { model: "" })).toBe(false);
    expect(store.getState().error).toBe("configure #1 failed: Bad configure: model expected string");
    expect(store.getState().forest.byId(1)?.model).toBe(null);
    store.stop();
  });

  it("orders the tab cycle newest-question-first, with parked runs as the backstop", async () => {
    const client = new StubClient();
    client.rows = [
      row(1),
      row(7, { status: "parked", parkReason: "question" }),
      row(9, { status: "parked", parkReason: "question" }),
      row(11, { status: "parked", parkReason: "sleeping" }), // waiting on time, not on us
    ];
    client.inboxRows = [
      inboxRow("q5", 5, "question", 3000),
      inboxRow("r6", 6, "review", 2500), // not a question: not in the cycle
      inboxRow("q7", 7, "question", 2000),
      inboxRow("q5b", 5, "question", 1000), // same run twice: visited once
    ];
    const { store } = boot(client);
    await flush();

    expect(store.actions.waiting()).toEqual([5, 7, 9]);
    store.stop();
  });

  it("fetches the persona list once and caches it", async () => {
    const client = new StubClient();
    client.personaRows = [persona("qa")];
    const { store } = boot(client);
    await flush();
    expect(client.personasCalls).toBe(0); // nothing fetches it until /new needs it

    store.actions.ensurePersonas();
    store.actions.ensurePersonas();
    await flush();
    expect(client.personasCalls).toBe(1);
    expect(store.getState().personas.map((p) => p.id)).toEqual(["qa"]);

    store.actions.ensurePersonas();
    await flush();
    expect(client.personasCalls).toBe(1);
    store.stop();
  });

  it("flattens the provider catalog once and caches it", async () => {
    const client = new StubClient();
    client.providerRows = {
      providers: [{ id: "anthropic", models: [] }],
      backends: [
        { id: "pi", providers: [{ id: "openai", models: [{ id: "gpt-6", name: "GPT-6" }] }] },
        {
          id: "claude",
          providers: [
            {
              id: "anthropic",
              models: [
                { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
                { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
              ],
            },
          ],
        },
      ],
      defaultBackend: "claude",
    };
    const { store } = boot(client);
    await flush();
    expect(client.providersCalls).toBe(0); // nothing fetches it until /model needs it

    store.actions.ensureModels();
    store.actions.ensureModels();
    await flush();
    expect(client.providersCalls).toBe(1);
    // Every backend's models, qualified and sorted; the two catalogs do not overlap.
    expect(store.getState().models.map((m) => m.value)).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-5",
      "openai/gpt-6",
    ]);

    store.actions.ensureModels();
    await flush();
    expect(client.providersCalls).toBe(1);
    store.stop();
  });

  it("keeps completion silent when the catalog never arrives", async () => {
    const client = new StubClient();
    const { store } = boot(client);
    await flush();
    const before = store.getState();

    store.actions.ensureModels();
    await flush();
    expect(store.getState().models).toEqual([]);
    // A missing catalog is a nicety, not an outage: status and error untouched.
    expect(store.getState().status).toBe(before.status);
    expect(store.getState().error).toBe(before.error);

    // A failed fetch stays retryable.
    client.providerRows = {
      providers: [],
      backends: [{ id: "claude", providers: [{ id: "anthropic", models: [{ id: "m", name: "M" }] }] }],
      defaultBackend: "claude",
    };
    store.actions.ensureModels();
    await flush();
    expect(store.getState().models.map((m) => m.value)).toEqual(["anthropic/m"]);
    store.stop();
  });
});
