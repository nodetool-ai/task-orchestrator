// __tests__/resume-failed-run.test.ts
//
// Resuming a FAILED run must fail loudly, not silently. Observed on box runs
// 26/27: a follow-up message on a failed run persisted the user row, dispatch
// failed synchronously (admission reject), and then (1) the SSE stream never
// yielded an error/done frame — the UI spun forever — and (2) the reject
// message was swallowed by setError's terminal guard, leaving the row showing
// the PREVIOUS attempt's stale error.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get, recordDispatchFailure, sendMessageToRun } from "../lib/runs";
import * as dispatch from "../lib/run-dispatch";

const ENV_KEYS = ["TASK_ORCH_WORKER_IMAGE", "TASK_ORCH_DETACHED_RUNS"] as const;
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

async function failedImplementRun(error: string) {
  const run = await create({ goal: "<implement>", defer: true });
  await db
    .update(agentSessions)
    .set({ status: "failed", error, branch: "claude/t-fail", completedAt: new Date() })
    .where(eq(agentSessions.id, run.id));
  return run;
}

describe("recordDispatchFailure", () => {
  it("refreshes the error on an already-failed run instead of silently no-oping", async () => {
    const run = await failedImplementRun("old spawn error from the previous attempt");
    await recordDispatchFailure(run.id, "Repository 'x' has no usable Git remote");
    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("Repository 'x' has no usable Git remote");
  });

  it("fails a non-terminal run through the normal terminal transition", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await recordDispatchFailure(run.id, "no capacity");
    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("no capacity");
  });

  it("never resurrects or rewrites a cancelled run", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db
      .update(agentSessions)
      .set({ status: "cancelled", error: null })
      .where(eq(agentSessions.id, run.id));
    await recordDispatchFailure(run.id, "should not land");
    const after = await get(run.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.error).toBeNull();
  });
});

describe("sendMessageToRun when dispatch fails synchronously", () => {
  it("yields an error frame with the recorded failure instead of hanging on the relay", async () => {
    // Remote-runner deployment as seen from the server.
    process.env.TASK_ORCH_WORKER_IMAGE = "orch-worker:test";
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const run = await failedImplementRun("old spawn error");
    // Real dispatch records the failure on the row before returning spawn-failed;
    // the mock mirrors that contract.
    vi.spyOn(dispatch, "dispatchRun").mockImplementation(async (runId: number) => {
      await recordDispatchFailure(runId, "Repository 'chess-analyzer' has no usable Git remote");
      return "spawn-failed";
    });

    const abort = new AbortController();
    const frames: Array<{ type: string; error?: string }> = [];
    // The generator must TERMINATE on its own — no abort, no timeout rescue.
    for await (const ev of sendMessageToRun({ runId: run.id, role: "user", text: "resume", abort })) {
      frames.push(ev as never);
      if (frames.length > 10) break; // safety valve; must not be reached
    }

    const err = frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    expect(err!.error).toMatch(/no usable Git remote/);
  });
});
