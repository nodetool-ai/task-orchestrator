// __tests__/worker-transport-semantics.test.ts
//
// Regression tests for transport semantics that came out of review:
//   • releaseClaim's stranded-message re-dispatch gate must mirror the exiting
//     loop's own rules (chat exit: never resurrect a terminal landing;
//     single-turn exit: only cancel/close block it).
//   • reviveDates must revive ONLY the known timestamp keys, never
//     agent-authored jsonb (run.result, message content).

import { describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import { dbTransport } from "../lib/worker/db-transport";
import { reviveDates } from "../lib/worker/protocol";
import * as runDispatch from "../lib/run-dispatch";

afterEach(() => vi.restoreAllMocks());

async function strandedChatRun(status: string) {
  const run = await create({ goal: "<chat>", defer: true });
  await dbTransport.appendMessage(run.id, "user", [{ type: "text", text: "follow-up" }]);
  await db
    .update(agentSessions)
    .set({ status, workerScope: "run-x", workerPid: 42, completedAt: new Date() })
    .where(eq(agentSessions.id, run.id));
  return run;
}

describe("releaseClaim re-dispatch gate", () => {
  it("chat exit does NOT resurrect a failed run over a stranded message", async () => {
    const run = await strandedChatRun("failed");
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);
    await dbTransport.releaseClaim(run.id, { lastProcessedUserMsgId: 0, idleIfNonTerminal: true });
    expect(spy).not.toHaveBeenCalled();
    const row = (await get(run.id))!;
    expect(row.status).toBe("failed"); // terminal landing untouched
    expect(row.workerScope).toBeNull(); // claim still released
  });

  it("chat exit re-dispatches a non-terminal run with a stranded message", async () => {
    const run = await strandedChatRun("idle");
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);
    await dbTransport.releaseClaim(run.id, { lastProcessedUserMsgId: 0, idleIfNonTerminal: true });
    expect(spy).toHaveBeenCalledWith(run.id);
    expect((await get(run.id))!.status).toBe("idle");
  });

  it("chat exit keeps a deliberately parked run parked", async () => {
    const run = await strandedChatRun("parked");
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);
    await db
      .update(agentSessions)
      .set({ parkReason: "waiting" })
      .where(eq(agentSessions.id, run.id));
    await dbTransport.releaseClaim(run.id, { lastProcessedUserMsgId: 999, idleIfNonTerminal: true });
    expect(spy).not.toHaveBeenCalled();
    expect((await get(run.id))!.status).toBe("parked");
  });

  it("single-turn exit revives a completed run with a newer message (FIX 3a) but never a cancelled one", async () => {
    const completed = await strandedChatRun("completed");
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);
    await dbTransport.releaseClaim(completed.id, { lastProcessedUserMsgId: 0 });
    expect(spy).toHaveBeenCalledWith(completed.id);

    spy.mockClear();
    const cancelled = await strandedChatRun("cancelled");
    await dbTransport.releaseClaim(cancelled.id, { lastProcessedUserMsgId: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not re-dispatch when the only newer user message is empty", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await dbTransport.appendMessage(run.id, "user", [{ type: "text", text: "   " }]);
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);
    await dbTransport.releaseClaim(run.id, { lastProcessedUserMsgId: 0, idleIfNonTerminal: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("HTTP-only worker enforcement", () => {
  it("runTransport refuses a worker process without worker API credentials", async () => {
    const { runTransport, __resetRunTransportForTests } = await import("../lib/worker");
    const saved = {
      inside: process.env.TASK_ORCH_INSIDE_WORKER,
      url: process.env.TASK_ORCH_WORKER_API_URL,
      token: process.env.TASK_ORCH_WORKER_TOKEN,
      allow: process.env.TASK_ORCH_WORKER_ALLOW_DB,
    };
    __resetRunTransportForTests();
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    delete process.env.TASK_ORCH_WORKER_API_URL;
    delete process.env.TASK_ORCH_WORKER_TOKEN;
    delete process.env.TASK_ORCH_WORKER_ALLOW_DB;
    try {
      expect(() => runTransport()).toThrow(/Direct-Postgres workers are no longer supported/);
    } finally {
      for (const [k, v] of [
        ["TASK_ORCH_INSIDE_WORKER", saved.inside],
        ["TASK_ORCH_WORKER_API_URL", saved.url],
        ["TASK_ORCH_WORKER_TOKEN", saved.token],
        ["TASK_ORCH_WORKER_ALLOW_DB", saved.allow],
      ] as const) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
      __resetRunTransportForTests();
    }
  });
});

describe("reviveDates", () => {
  it("revives known timestamp keys and leaves agent-authored jsonb alone", () => {
    const iso = "2026-07-06T10:00:00.000Z";
    const wire = {
      run: {
        startedAt: iso,
        completedAt: null,
        heartbeatAt: iso,
        result: { expiresAt: iso, note: "agent-authored" },
      },
      message: {
        createdAt: iso,
        content: [{ type: "text", text: iso, foundAt: iso }],
      },
      // Unknown *At keys outside opaque subtrees stay strings too.
      seenAt: iso,
    };
    const revived = reviveDates(wire) as typeof wire;
    expect(revived.run.startedAt).toBeInstanceOf(Date);
    expect(revived.run.heartbeatAt).toBeInstanceOf(Date);
    expect(revived.message.createdAt).toBeInstanceOf(Date);
    // jsonb / content subtrees are opaque: strings stay strings.
    expect(revived.run.result.expiresAt).toBe(iso);
    expect(revived.message.content[0].foundAt).toBe(iso);
    expect(revived.message.content[0].text).toBe(iso);
    // Not in the known-key list → untouched.
    expect(revived.seenAt).toBe(iso);
  });
});
