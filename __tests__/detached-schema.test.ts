// __tests__/detached-schema.test.ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";

describe("detached run worker columns", () => {
  it("persists worker identity and cancel flag", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db.update(agentSessions)
      .set({ workerScope: "run-1-abc", workerPid: 4242, cancelRequested: 1 })
      .where(eq(agentSessions.id, run.id));
    const row = (await get(run.id))!;
    expect(row.workerScope).toBe("run-1-abc");
    expect(row.workerPid).toBe(4242);
    expect(row.cancelRequested).toBe(1);
  });
});
