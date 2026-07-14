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

  it("persists nullable Box checkpoint and credential metadata", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const snapshotCompletedAt = new Date("2026-07-14T12:00:00.000Z");
    const checkpointRequestedAt = new Date("2026-07-14T12:01:00.000Z");
    const lastCheckpointAt = new Date("2026-07-14T12:02:00.000Z");
    const credentialsExpiresAt = new Date("2026-07-21T12:00:00.000Z");

    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "box",
      state: "stopped",
      boxId: "box-current",
      boxTemplateId: "box-template",
      boxSourceId: "box-prior",
      snapshotId: "snapshot-1",
      snapshotCompletedAt,
      checkpointRequestedAt,
      lastCheckpointAt,
      credentialsVersion: 2,
      credentialsExpiresAt,
      workerVersion: "worker-v1",
      lastProviderError: "transient: request-id=req-1",
    });

    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row).toMatchObject({
      boxId: "box-current",
      boxTemplateId: "box-template",
      boxSourceId: "box-prior",
      snapshotId: "snapshot-1",
      snapshotCompletedAt,
      checkpointRequestedAt,
      lastCheckpointAt,
      credentialsVersion: 2,
      credentialsExpiresAt,
      workerVersion: "worker-v1",
      lastProviderError: "transient: request-id=req-1",
    });
  });
});
