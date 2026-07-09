// __tests__/dispatch-routing.test.ts
//
// Phase 3: create()'s secondary launch branches (kickoff / review / execute)
// route through dispatchRun() when TASK_ORCH_DETACHED_RUNS is on, and run
// in-process (today's behavior) when it's off. The caller-facing streaming
// append() path is deliberately NOT gated here — it stays in-process.
import { describe, expect, it, vi, afterEach } from "vitest";
import * as dispatch from "../lib/run-dispatch";
import * as repo from "../lib/repo";
import { create } from "../lib/runs";

// The postgres-mode loop is the seam a lightweight executor drives through
// runOneTurn now (R3); stub it so an in-process launch completes fast and makes
// no real model call.
vi.mock("../lib/agent-backend/postgres-turn", () => ({
  runPostgresTurn: async () => ({
    envelopes: [],
    summary: null,
    resumeToken: null,
    totalCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    turns: 0,
  }),
}));

afterEach(() => {
  delete process.env.TASK_ORCH_DETACHED_RUNS;
  delete process.env.TASK_ORCH_LIGHTWEIGHT_EXECUTOR;
  delete process.env.TASK_ORCH_INSIDE_WORKER;
  vi.restoreAllMocks();
});

describe("create() routing under the flag", () => {
  it("dispatches instead of running in-process when the flag is on", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    process.env.TASK_ORCH_LIGHTWEIGHT_EXECUTOR = "0";
    const plan = await repo.createPlan({ title: "Dispatch On", date: "2026-07-02" });
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    await create({ goal: "<execute>", planId: plan.id, defer: false } as any);
    await new Promise((r) => setTimeout(r, 20)); // allow the async launch branch to run
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps the default pi plan executor on the lightweight loop even when detached runs are on", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const plan = await repo.createPlan({ title: "Lightweight Dispatch Bypass", date: "2026-07-02" });
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    await create({ goal: "<execute>", planId: plan.id, backend: "pi", defer: false } as any);
    await new Promise((r) => setTimeout(r, 20)); // allow the async launch branch to run
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not use the lightweight executor loop inside a run worker", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    const plan = await repo.createPlan({ title: "Worker Executor Harness", date: "2026-07-02" });
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    await create({ goal: "<execute>", planId: plan.id, backend: "pi", defer: false } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT dispatch when the flag is off", async () => {
    const plan = await repo.createPlan({ title: "Dispatch Off", date: "2026-07-02" });
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    // defer:true so no real in-process worker starts
    await create({ goal: "<execute>", planId: plan.id, defer: true } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });
});
