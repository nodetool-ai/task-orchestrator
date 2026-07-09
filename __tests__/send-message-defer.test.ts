// __tests__/send-message-defer.test.ts
//
// Follow-up messages sent from INSIDE an isolate-mode worker (a parent
// executor doing spawn__append_message) must not drive the child's turn
// in-process (the worker has no Fly credentials and shares its 4GB Machine),
// and must not call dispatchRun (same credential problem). Instead the child
// row is parked at 'pending' — the dispatch request the SERVER's pump picks
// up, resuming the child's own Machine. Mirrors launchDetached's isolate
// deferral for child CREATION (docs/nested-machine-dispatch.md).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/chat-ai-loop", () => ({
  runChatAiTurn: vi.fn(async ({ run }: any) => {
    const { runTransport } = await import("../lib/worker");
    const blocks = [{ type: "text", text: "hi" }];
    const message = await (await runTransport()).appendMessage(run.id, "agent", blocks);
    return {
      events: [
        {
          type: "sdk",
          sdk: { type: "assistant", message: { content: blocks } },
          message,
        },
      ],
      summary: "hi",
      totalCostUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      turns: 1,
    };
  }),
}));

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { agentEvents, agentSessions } from "../db/schema";
import { create, get, sendMessageToRun } from "../lib/runs";
import * as dispatch from "../lib/run-dispatch";
import * as chatLoop from "../lib/chat-ai-loop";

const ENV_KEYS = [
  "TASK_ORCH_WORKER_ALLOW_DB",
  "TASK_ORCH_INSIDE_WORKER",
  "TASK_ORCH_NESTED_DISPATCH",
  "TASK_ORCH_RUNNER",
  "TASK_ORCH_WORKER_IMAGE",
  "TASK_ORCH_DETACHED_RUNS",
  "TASK_ORCH_LIGHTWEIGHT_CHATS",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function workerIsolateEnv() {
  process.env.TASK_ORCH_INSIDE_WORKER = "1";
  process.env.TASK_ORCH_WORKER_ALLOW_DB = "1"; // test-only: simulated worker in the orchestrator process
  process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
}

/** Pull exactly one frame (persist+defer happen before the first yield), then close. */
async function fireAppend(runId: number, text: string) {
  const abort = new AbortController();
  const gen = sendMessageToRun({ runId, role: "user", text, abort });
  await gen.next();
  abort.abort();
  await gen.return(undefined as never).catch(() => {});
}

describe("sendMessageToRun inside an isolate-mode worker", () => {
  it("parks a finished implement child at 'pending' instead of dispatching", async () => {
    workerIsolateEnv();
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "completed", branch: "claude/t-x-1", sdkSessionId: "sess-1" })
      .where(eq(agentSessions.id, run.id));

    await fireAppend(run.id, "resume: push the branch and open the PR");

    const after = await get(run.id);
    expect(after?.status).toBe("pending"); // the dispatch request for the server pump
    expect(after?.heartbeatAt).not.toBeNull(); // pending-episode stamp (MAX_DEFER_MS clock)
    expect(spy).not.toHaveBeenCalled(); // workers must never dispatch
    const deferred = await db.select().from(agentEvents)
      .where(and(eq(agentEvents.sessionId, run.id), eq(agentEvents.type, "runner_deferred")))
      .orderBy(desc(agentEvents.id)).limit(1);
    expect(deferred.length).toBe(1);
  });

  it("leaves a child with a LIVE worker claim untouched (its turn drains the message)", async () => {
    workerIsolateEnv();
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "running", workerScope: "run-live-1", heartbeatAt: new Date() })
      .where(eq(agentSessions.id, run.id));

    await fireAppend(run.id, "additional guidance mid-turn");

    const after = await get(run.id);
    expect(after?.status).toBe("running"); // NOT parked
    expect(after?.workerScope).toBe("run-live-1"); // claim intact
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("sendMessageToRun on the server (unchanged behavior)", () => {
  it("still dispatches via dispatchRun", async () => {
    // Remote deployment seen from the SERVER: worker-image mode.
    process.env.TASK_ORCH_WORKER_IMAGE = "orch-worker:test";
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "completed", branch: "claude/t-x-2", sdkSessionId: "sess-2" })
      .where(eq(agentSessions.id, run.id));

    await fireAppend(run.id, "server-side follow-up");

    expect(spy).toHaveBeenCalledWith(run.id);
    expect((await get(run.id))?.status).toBe("completed"); // parking is worker-only
  });

  it("keeps chat turns in-process even when remote runners are enabled", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "orch-worker:test";
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<chat>", defer: true });

    const abort = new AbortController();
    const frames = [];
    for await (const ev of sendMessageToRun({ runId: run.id, role: "user", text: "hello", abort })) {
      frames.push(ev.type);
      if (ev.type === "done" || ev.type === "error") break;
    }

    expect(frames).toContain("user_message");
    expect(frames).toContain("sdk");
    expect(frames).toContain("done");
    expect(spy).not.toHaveBeenCalled();
    expect(chatLoop.runChatAiTurn).toHaveBeenCalled();
    expect((await get(run.id))?.status).toBe("idle");
  });

  it("keeps a lightweight chat parked when a tool sets parkReason", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "orch-worker:test";
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    (chatLoop.runChatAiTurn as any).mockImplementationOnce(async ({ run }: any) => {
      const { runTransport } = await import("../lib/worker");
      await (await runTransport()).patchRun(run.id, { parkReason: "waiting" });
      return {
        events: [],
        summary: "waiting",
        totalCostUsd: null,
        inputTokens: 0,
        outputTokens: 0,
        turns: 1,
      };
    });
    const run = await create({ goal: "<chat>", defer: true });

    const abort = new AbortController();
    for await (const ev of sendMessageToRun({ runId: run.id, role: "user", text: "wait", abort })) {
      if (ev.type === "done" || ev.type === "error") break;
    }

    const after = await get(run.id);
    expect(after?.status).toBe("parked");
    expect(after?.parkReason).toBe("waiting");
  });
});
