// __tests__/cross-process-cancel.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, cancel, isCancelRequested } from "../lib/runs";

afterEach(() => { delete process.env.TASK_ORCH_DETACHED_RUNS; });

describe("DB-mediated cancel", () => {
  it("sets cancel_requested when the flag is on", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions).set({ status: "running"}).where(eq(agentSessions.id, run.id));
    await cancel(run.id);
    expect(await isCancelRequested(run.id)).toBe(true);
  });
});
