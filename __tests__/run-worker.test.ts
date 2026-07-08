import { describe, expect, it, vi } from "vitest";
import { create, get, listMessages, driveDispatchedRun } from "../lib/runs";
import { db } from "../db";
import { agentMessages } from "../db/schema";
import * as backend from "../lib/agent-backend";

// driveDispatchedRun is the detached-worker re-entry point. For a chat run it now
// enters the long-lived driveChatSession loop: one turn per inbound user message,
// then idle-wait until TASK_ORCH_CHAT_IDLE_MS, then exit resumable-idle.
describe("driveDispatchedRun", () => {
  it("runs a chat turn per pre-persisted user message, then idles out", async () => {
    // Shrink the idle timeout so the loop exits promptly after draining.
    process.env.TASK_ORCH_CHAT_IDLE_MS = "150";
    process.env.TASK_ORCH_LIGHTWEIGHT_CHATS = "0";
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake",
      listProviders: () => [],
      async runTurn(args: any) {
        args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
        args.onEvent({ type: "result", is_error: false, result: "done", usage: {} });
        return {
          envelopes: [],
          summary: "done",
          resumeToken: "sess-1",
          turns: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: null,
        };
      },
    } as any);

    const run = await create({ goal: "<chat>", defer: true });
    // Simulate the server persisting the user message (what wakes the worker).
    await db.insert(agentMessages).values({
      runId: run.id,
      role: "user",
      content: JSON.stringify([{ type: "text", text: "hi" }]),
      createdAt: new Date(),
    });

    await driveDispatchedRun(run.id); // enters driveChatSession: drain -> turn -> idle-out

    expect((await get(run.id))!.status).toBe("idle");
    const msgs = await listMessages(run.id);
    expect(msgs.some((m) => m.role === "agent")).toBe(true);
    // The worker ran with persistUser:false — the pre-persisted message is NOT duplicated.
    expect(msgs.filter((m) => m.role === "user").length).toBe(1);
    // The claim is released so the next message re-dispatches a fresh worker.
    expect((await get(run.id))!.workerScope).toBeNull();

    delete process.env.TASK_ORCH_CHAT_IDLE_MS;
    delete process.env.TASK_ORCH_LIGHTWEIGHT_CHATS;
    vi.restoreAllMocks();
  });

  it("is a no-op for a missing run", async () => {
    await expect(driveDispatchedRun(999999)).resolves.toBeUndefined();
  });
});
