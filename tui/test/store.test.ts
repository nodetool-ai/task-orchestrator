// The store drives every subscription and timer in the cockpit, so it is
// tested headless: a stub client, an injected clock, no renderer and no sleeps.

import { describe, expect, it } from "vitest";
import { UnauthorizedError, type OrchClient, type OverviewHandlers, type RunEventHandlers, type Subscription } from "../src/api/client.js";
import type { GlobalInboxRow, MessageRow, PlanSummary, RunDetail, RunIndexRow, StreamCursor, TaskSummary } from "../src/api/types.js";
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
});
