// __tests__/pending-reason.test.ts
// Spec §2: a deferred run is never a bare 'pending' — admission's defer reason
// is persisted to agent_runs.pending_reason, and the atomic claim clears it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";
import { getRunOverview } from "../lib/run-overview";

const KNOBS = ["TASK_ORCH_RUNNER", "TASK_ORCH_WORKER_IMAGE"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  vi.restoreAllMocks();
});

async function pendingReasonOf(runId: number): Promise<string | null> {
  const [row] = await db
    .select({ pendingReason: agentSessions.pendingReason })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId));
  return row?.pendingReason ?? null;
}

describe("pending_reason", () => {
  it("persists the provider defer reason when admission defers", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test"; // keep placement on the worker path
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, {
      providerAdmit: async () => ({ decision: "defer", reason: "Runner capacity exhausted…" }),
    });
    expect(result).toBe("deferred");
    expect(await pendingReasonOf(run.id)).toBe("Runner capacity exhausted…");
  });

  it("falls back to a generic reason when the defer carries none", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, { spawn: vi.fn(() => 1), admit: () => "defer" });
    expect(result).toBe("deferred");
    expect(await pendingReasonOf(run.id)).toBe("Waiting for runner capacity.");
  });

  it("clears the reason when the run is admitted and claimed", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });
    await dispatchRun(run.id, { spawn: vi.fn(() => 1), admit: () => "defer" });
    expect(await pendingReasonOf(run.id)).not.toBeNull();

    const result = await dispatchRun(run.id, { spawn: vi.fn(() => 1), admit: () => "admit" });
    expect(result).toBe("spawned");
    expect(await pendingReasonOf(run.id)).toBeNull();
  });
});

describe("run overview", () => {
  it("serializes pendingReason onto RunIndexRow", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db
      .update(agentSessions)
      .set({ status: "pending", pendingReason: "Runner capacity exhausted…" })
      .where(eq(agentSessions.id, run.id));
    const rows = await getRunOverview();
    const row = rows.find((r) => r.id === run.id)!;
    expect(row.pendingReason).toBe("Runner capacity exhausted…");
  });
});
