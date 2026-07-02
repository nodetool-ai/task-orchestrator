// __tests__/run-dispatch.test.ts
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";

describe("dispatchRun", () => {
  it("claims an unclaimed run and calls spawn once", () => {
    const run = create({ goal: "<implement>", taskId: null as any, defer: true });
    const spawn = vi.fn(() => 5555);
    const result = dispatchRun(run.id, { spawn });
    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    const row = get(run.id)!;
    expect(row.status).toBe("preparing");
    expect(row.workerScope).toMatch(/^run-\d+-/);
    expect(row.workerPid).toBe(5555);
  });

  it("is idempotent — a second dispatch does not spawn again", () => {
    const run = create({ goal: "<implement>", defer: true });
    dispatchRun(run.id, { spawn: () => 1 });
    const spawn2 = vi.fn(() => 2);
    expect(dispatchRun(run.id, { spawn: spawn2 })).toBe("already-claimed");
    expect(spawn2).not.toHaveBeenCalled();
  });

  it("returns not-found for a missing run", () => {
    expect(dispatchRun(999999, { spawn: () => 1 })).toBe("not-found");
  });

  it("does not dispatch a run holding a live lease", () => {
    const run = create({ goal: "<implement>", defer: true });
    db.update(agentSessions)
      .set({ status: "running", heartbeatAt: new Date() })
      .where(eq(agentSessions.id, run.id))
      .run();
    expect(dispatchRun(run.id, { spawn: () => 1 })).toBe("already-claimed");
  });
});
