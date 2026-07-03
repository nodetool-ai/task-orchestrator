// __tests__/run-dispatch.test.ts
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun, runtimeEnv } from "../lib/run-dispatch";

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

  // Regression: a spawn that throws (bad module resolution in the prod bundle —
  // the 'Cannot find module tsx/cli' incident) must fail the run, not wedge it
  // in 'preparing' with no error and no worker.
  it("marks the run failed (not wedged in preparing) when spawn throws", () => {
    const run = create({ goal: "<implement>", defer: true });
    const result = dispatchRun(run.id, {
      spawn: () => {
        throw new Error("boom-tsx");
      },
    });
    expect(result).toBe("spawn-failed");
    const row = get(run.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/boom-tsx/);
    expect(row.workerScope).toBeNull(); // claim released for retry
  });

  it("marks the run failed when spawn returns no pid (executable not found)", () => {
    const run = create({ goal: "<implement>", defer: true });
    const result = dispatchRun(run.id, { spawn: () => null });
    expect(result).toBe("spawn-failed");
    const row = get(run.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/did not start/);
  });
});

describe("runtimeEnv", () => {
  // Regression: `systemd-run --user` needs XDG_RUNTIME_DIR to reach the user bus;
  // a systemd service env lacks it, which wedged runs in 'preparing' in prod.
  it("adds XDG_RUNTIME_DIR (from the uid) for systemd spawns when missing", () => {
    const base = { PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv; // no XDG_RUNTIME_DIR
    const env = runtimeEnv(base, true);
    expect(env.XDG_RUNTIME_DIR).toBe(`/run/user/${process.getuid!()}`);
  });

  it("preserves an existing XDG_RUNTIME_DIR", () => {
    const base = { XDG_RUNTIME_DIR: "/run/user/custom" } as unknown as NodeJS.ProcessEnv;
    expect(runtimeEnv(base, true).XDG_RUNTIME_DIR).toBe("/run/user/custom");
  });

  it("does not add XDG_RUNTIME_DIR for the non-systemd fallback", () => {
    const env = runtimeEnv({ PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv, false);
    expect(env.XDG_RUNTIME_DIR).toBeUndefined();
  });
});
