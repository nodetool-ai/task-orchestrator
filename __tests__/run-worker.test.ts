import { describe, expect, it, vi } from "vitest";
import { create, get, listMessages, driveDispatchedRun } from "../lib/runs";
import * as backend from "../lib/agent-backend";

// Stub getBackend to a fake whose runTurn emits one assistant envelope then a
// result. driveDispatchedRun is the detached-worker re-entry point: it should
// pick the right worker for a run and drive one turn to completion.
describe("driveDispatchedRun", () => {
  it("runs a chat turn to a terminal/idle status and persists an agent message", async () => {
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

    const run = create({ goal: "<chat>", defer: true });
    await driveDispatchedRun(run.id);

    expect(["idle", "completed"]).toContain(get(run.id)!.status);
    expect(listMessages(run.id).some((m) => m.role === "agent")).toBe(true);
    vi.restoreAllMocks();
  });

  it("is a no-op for a missing run", async () => {
    await expect(driveDispatchedRun(999999)).resolves.toBeUndefined();
  });
});
