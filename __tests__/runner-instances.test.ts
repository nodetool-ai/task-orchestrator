import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { runnerInstances } from "../db/schema";
import { create } from "../lib/runs";

describe("runner_instances", () => {
  it("stores the machine/volume/region mapping for a run", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "fly",
      flyApp: "app",
      machineId: "m1",
      volumeId: "v1",
      region: "ams",
      state: "running",
    });
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row).toMatchObject({ machineId: "m1", volumeId: "v1", region: "ams", state: "running" });
  });
});
