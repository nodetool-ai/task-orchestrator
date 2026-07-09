// __tests__/runs-chat-drain.test.ts
//
// BUG 2: driveChatSession dropped a user message that landed right as the idle
// timeout fired. sendMessageToRun saw isWorkerLive()===true (claim intact,
// heartbeat fresh), so it only NOTIFYed and did NOT dispatch — but the notify
// landed after the timeout nulled `wake`, the worker exited, and the message sat
// unprocessed until some FUTURE message triggered a dispatch.
//
// Fix: (a) on timeout, re-check pendingWake and keep draining if set; (b) after
// the finally releases the claim, do a last check for unprocessed non-empty user
// messages and fire-and-forget a fresh dispatchRun so a new worker drains them
// (also covers a NOTIFY lost entirely).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, agentMessages, agentEvents } from "../db/schema";
import { create, get, driveChatSession } from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";
import * as backend from "../lib/agent-backend";
import * as dispatch from "../lib/run-dispatch";

function fakeBackend() {
  return {
    id: "fake",
    async runTurn(args: any) {
      args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
      args.onEvent({ type: "result", is_error: false, result: "hi", usage: {} });
      return { summary: "hi", resumeToken: "sess-1", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
    },
  } as any;
}

async function insertUserMessage(runId: number, text: string) {
  await db.insert(agentMessages).values({
    runId,
    role: "user",
    content: JSON.stringify([{ type: "text", text }]),
    createdAt: new Date(),
  });
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
  // Short idle timeout so the worker loop exits quickly in-test.
  process.env.TASK_ORCH_CHAT_IDLE_MS = "300";
  process.env.TASK_ORCH_LIGHTWEIGHT_CHATS = "0";
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.TASK_ORCH_CHAT_IDLE_MS;
  delete process.env.TASK_ORCH_LIGHTWEIGHT_CHATS;
  // Restore the run_input trigger a test may have disabled to simulate a lost NOTIFY.
  await db
    .execute(sql`ALTER TABLE agent_messages ENABLE TRIGGER agent_messages_notify_input`)
    .catch(() => {});
});

describe("driveChatSession message drain (BUG 2)", () => {
  it("drains a pending user message and does NOT spuriously re-dispatch", async () => {
    vi.spyOn(backend, "getBackend").mockResolvedValue(fakeBackend());
    const redispatch = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<chat>", defer: true });
    // Message is present before the loop starts → drained inside the loop.
    await insertUserMessage(run.id, "hello");

    await driveChatSession(run.id);

    // The turn ran to completion: exactly one turn_done marker.
    const done = await db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, run.id), eq(agentEvents.type, "turn_done")));
    expect(done.length).toBe(1);
    // Message was processed, so the finally's final-drain finds nothing stranded.
    expect(redispatch).not.toHaveBeenCalled();
    expect((await get(run.id))?.status).toBe("idle");
  });

  it("re-dispatches a user message stranded past the idle timeout (lost NOTIFY)", async () => {
    vi.spyOn(backend, "getBackend").mockResolvedValue(fakeBackend());
    const redispatch = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<chat>", defer: true });

    // Simulate a LOST run_input NOTIFY: with the trigger off, the worker's LISTEN
    // never learns of the message, so the loop never drains it — it can only be
    // caught by the finally's final-drain guard.
    await db.execute(sql`ALTER TABLE agent_messages DISABLE TRIGGER agent_messages_notify_input`);

    const loop = driveChatSession(run.id);
    // Let the loop pass its initial (empty) drain and enter the idle-wait.
    await new Promise((r) => setTimeout(r, 60));
    await insertUserMessage(run.id, "are you there?");
    await loop; // idle-times-out, exits, final-drain fires

    expect(redispatch).toHaveBeenCalledWith(run.id);
  });

  it("keeps an SDK-backed chat parked when a tool sets parkReason", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake",
      async runTurn(args: any) {
        await db
          .update(agentSessions)
          .set({ parkReason: "waiting" })
          .where(eq(agentSessions.id, run.id));
        args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "waiting" }] } });
        args.onEvent({ type: "result", is_error: false, result: "waiting", usage: {} });
        return {
          summary: "waiting",
          resumeToken: "sess-park",
          turns: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: null,
          envelopes: [],
        };
      },
    } as any);
    await insertUserMessage(run.id, "wait for child");

    await driveChatSession(run.id);

    const after = await get(run.id);
    expect(after?.status).toBe("parked");
    expect(after?.parkReason).toBe("waiting");
    expect(after?.workerScope).toBeNull();
  });
});
