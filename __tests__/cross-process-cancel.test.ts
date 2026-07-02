// __tests__/cross-process-cancel.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, cancel, isCancelRequested } from "../lib/runs";

afterEach(() => { delete process.env.TASK_ORCH_DETACHED_RUNS; });

describe("DB-mediated cancel", () => {
  it("sets cancel_requested when the flag is on", () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const run = create({ goal: "<implement>", defer: true });
    db.update(agentSessions).set({ status: "running", heartbeatAt: new Date() }).where(eq(agentSessions.id, run.id)).run();
    cancel(run.id);
    expect(isCancelRequested(run.id)).toBe(true);
  });
});
