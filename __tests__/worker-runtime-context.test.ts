// __tests__/worker-runtime-context.test.ts
//
// Unit coverage for the worker-side run context construction and ordered input
// queue (plan section 13.1 / 13.3). These are the tractable, pure pieces of the
// ws run driver; they carry no DB or channel I/O and are tested in isolation.

import { describe, expect, it } from "vitest";
import {
  buildWorkerRunContext,
  driveWorkerRun,
  isRunInput,
  OrderedInputQueue,
  WorkerSeamNotWiredError,
  type WorkerDriverSession,
} from "../lib/worker-runtime/context";
import type {
  MessageSnapshot,
  RunInput,
  RunStart,
  WorkerSessionCommand,
} from "../lib/worker-channel/protocol";

function msg(id: number, role: MessageSnapshot["role"], text = `m${id}`): MessageSnapshot {
  return { id, role, content: [{ type: "text", text }] };
}

function makeStart(overrides: Partial<RunStart> = {}): RunStart {
  return {
    mode: "start",
    run: { id: 1, status: "running" },
    task: null,
    plan: null,
    persona: { id: "implementor" },
    repository: { id: "repo-1" },
    transcript: [msg(1, "user", "hi"), msg(2, "agent", "hello")],
    inboxDigest: null,
    memoryContext: "",
    pendingInput: [],
    policy: { allowedTools: [], maxTurns: null, deadline: null },
    ...overrides,
  };
}

// A minimal command iterator double: yields the supplied commands then closes.
function fakeSession(commands: WorkerSessionCommand[] = []): WorkerDriverSession {
  return {
    async *commands() {
      for (const command of commands) yield command;
    },
    async emit() {
      return undefined;
    },
  };
}

describe("buildWorkerRunContext", () => {
  it("maps every RunStart snapshot field onto the context", () => {
    const start = makeStart({
      task: { id: "task-9", title: "T" },
      plan: { id: "plan-3" },
      persona: { id: "reviewer", toolsProfile: "orchestrator" },
      repository: { id: "repo-7", remote: "git@x" },
    });
    const session = fakeSession();
    const context = buildWorkerRunContext(start, session);

    expect(context.start).toBe(start);
    expect(context.session).toBe(session);
    expect(context.run).toEqual(start.run);
    expect(context.task).toEqual(start.task);
    expect(context.plan).toEqual(start.plan);
    expect(context.persona).toEqual(start.persona);
    expect(context.repository).toEqual(start.repository);
  });

  it("carries null optional task and plan through unchanged", () => {
    const context = buildWorkerRunContext(makeStart({ task: null, plan: null }), fakeSession());
    expect(context.task).toBeNull();
    expect(context.plan).toBeNull();
  });

  it("seeds the transcript view from transcript + pending input in order", () => {
    const start = makeStart({
      transcript: [msg(1, "user"), msg(2, "agent")],
      pendingInput: [msg(3, "user", "follow up")],
    });
    const context = buildWorkerRunContext(start, fakeSession());
    expect(context.transcript.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("returns a fresh transcript array that does not alias the snapshot", () => {
    const start = makeStart();
    const context = buildWorkerRunContext(start, fakeSession());
    context.transcript.push(msg(99, "user"));
    expect(start.transcript.map((m) => m.id)).toEqual([1, 2]);
  });
});

describe("OrderedInputQueue", () => {
  it("accepts strictly increasing ids and appends them to the transcript view", () => {
    const transcript: MessageSnapshot[] = [];
    const queue = new OrderedInputQueue(transcript);
    expect(queue.offer(msg(10, "user"))).toBe("accepted");
    expect(queue.offer(msg(11, "user"))).toBe("accepted");
    expect(transcript.map((m) => m.id)).toEqual([10, 11]);
    expect(queue.highWaterMark()).toBe(11);
  });

  it("ignores a duplicate id without re-appending", () => {
    const transcript: MessageSnapshot[] = [];
    const queue = new OrderedInputQueue(transcript);
    queue.offer(msg(5, "user"));
    expect(queue.offer(msg(5, "user"))).toBe("duplicate");
    expect(transcript.map((m) => m.id)).toEqual([5]);
  });

  it("rejects a decreasing non-duplicate id", () => {
    const transcript: MessageSnapshot[] = [];
    const queue = new OrderedInputQueue(transcript);
    queue.offer(msg(20, "user"));
    expect(queue.offer(msg(15, "user"))).toBe("rejected");
    expect(transcript.map((m) => m.id)).toEqual([20]);
    expect(queue.highWaterMark()).toBe(20);
  });

  it("seeds its high-water mark and duplicate set from a pre-seeded transcript", () => {
    // A reconnect that replays already-visible pending input must be a no-op.
    const transcript = [msg(1, "user"), msg(2, "agent"), msg(3, "user")];
    const queue = new OrderedInputQueue(transcript);
    expect(queue.highWaterMark()).toBe(3);
    expect(queue.offer(msg(3, "user"))).toBe("duplicate");
    expect(queue.offer(msg(2, "agent"))).toBe("duplicate");
    expect(transcript.length).toBe(3);
  });

  it("drains accepted-but-unconsumed inputs in id order, once", () => {
    const queue = new OrderedInputQueue([]);
    queue.offer(msg(1, "user"));
    queue.offer(msg(2, "user"));
    expect(queue.hasPending()).toBe(true);
    expect(queue.drain().map((m) => m.id)).toEqual([1, 2]);
    expect(queue.hasPending()).toBe(false);
    expect(queue.drain()).toEqual([]);
  });

  it("offerBatch sorts a batch and classifies each message", () => {
    const transcript: MessageSnapshot[] = [];
    const queue = new OrderedInputQueue(transcript);
    const input: RunInput = { messages: [msg(3, "user"), msg(1, "user"), msg(3, "user")] };
    // offerBatch sorts to [1, 3, 3]: 1 accepted, 3 accepted (new high-water),
    // second 3 a duplicate. Outcomes are returned in that sorted order.
    expect(queue.offerBatch(input)).toEqual(["accepted", "accepted", "duplicate"]);
    expect(transcript.map((m) => m.id)).toEqual([1, 3]);
  });
});

describe("isRunInput", () => {
  it("recognizes a run.input payload by its messages array", () => {
    expect(isRunInput({ messages: [] } as RunInput)).toBe(true);
  });

  it("rejects non-input commands", () => {
    expect(isRunInput({ reason: "x", requestId: "r", deadline: null } as WorkerSessionCommand)).toBe(
      false
    );
    expect(isRunInput({ status: "completed" } as WorkerSessionCommand)).toBe(false);
  });
});

describe("driveWorkerRun", () => {
  it("builds context from { start, session }, runs the input loop, and stops at the write seam", async () => {
    // The write seam is not wired until section 14, so a ws-mode drive reaches
    // it and fails fast with the explicit seam error rather than reading a
    // forbidden transport.
    const session = fakeSession([{ messages: [msg(3, "user", "hi")] } as RunInput]);
    await expect(driveWorkerRun({ start: makeStart(), session })).rejects.toBeInstanceOf(
      WorkerSeamNotWiredError
    );
  });
});
