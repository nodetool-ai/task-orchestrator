import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  runnerInstances,
  workerChannelCommands,
  workerChannelReceipts,
} from "../db/schema";
import { create } from "../lib/runs";

const INSTANCE_ID = "wi_0123456789abcdef0123456789abcdef";

beforeEach(async () => {
  await db.delete(agentSessions);
});

async function makeRun(): Promise<number> {
  const run = await create({ goal: "<chat>", defer: true });
  return run.id;
}

function commandValues(runId: number, id: string, epoch: number, seq: number) {
  return {
    id,
    runId,
    instanceId: INSTANCE_ID,
    controllerEpoch: epoch,
    seq,
    type: "run.input",
    payload: { messages: [] },
  };
}

describe("worker channel schema", () => {
  it("persists runner channel identity, endpoint, lease, and liveness fields", async () => {
    const runId = await makeRun();
    await db.insert(runnerInstances).values({
      runId,
      channelInstanceId: INSTANCE_ID,
      channelEndpoint: "unix:///tmp/worker.sock",
      controllerEpoch: 4,
      controllerId: "controller-test",
    });

    const [row] = await db
      .select()
      .from(runnerInstances)
      .where(eq(runnerInstances.runId, runId));
    expect(row).toMatchObject({
      channelInstanceId: INSTANCE_ID,
      channelEndpoint: "unix:///tmp/worker.sock",
      controllerEpoch: 4,
      controllerId: "controller-test",
    });
  });

  it("persists generation state and separates command/receipt sequence spaces", async () => {
    const runId = await makeRun();
    await db.insert(runnerInstances).values({
      runId,
      channelInstanceId: INSTANCE_ID,
      workerGeneration: 2,
      generationState: "active",
      providerOperationId: "00000000-0000-4000-8000-000000000001",
      providerServiceName: "worker-g2",
    });
    const [runner] = await db
      .select({
        workerGeneration: runnerInstances.workerGeneration,
        generationState: runnerInstances.generationState,
        providerServiceName: runnerInstances.providerServiceName,
      })
      .from(runnerInstances)
      .where(eq(runnerInstances.runId, runId));
    expect(runner).toEqual({
      workerGeneration: 2,
      generationState: "active",
      providerServiceName: "worker-g2",
    });

    await db.insert(workerChannelCommands).values([
      { ...commandValues(runId, "00000000-0000-4000-8000-000000000011", 1, 1), workerGeneration: 1 },
      { ...commandValues(runId, "00000000-0000-4000-8000-000000000012", 1, 1), workerGeneration: 2 },
    ]);
    await db.insert(workerChannelReceipts).values([
      {
        id: "10000000-0000-4000-8000-000000000011",
        runId,
        instanceId: INSTANCE_ID,
        workerGeneration: 1,
        workerSeq: 1,
        controllerEpoch: 1,
        type: "run.phase",
        payloadSha256: "generation-1",
      },
      {
        id: "10000000-0000-4000-8000-000000000012",
        runId,
        instanceId: INSTANCE_ID,
        workerGeneration: 2,
        workerSeq: 1,
        controllerEpoch: 1,
        type: "run.phase",
        payloadSha256: "generation-2",
      },
    ]);
    const commands = await db
      .select({ workerGeneration: workerChannelCommands.workerGeneration, seq: workerChannelCommands.seq })
      .from(workerChannelCommands)
      .where(eq(workerChannelCommands.runId, runId));
    expect(commands).toEqual(
      expect.arrayContaining([
        { workerGeneration: 1, seq: 1 },
        { workerGeneration: 2, seq: 1 },
      ]),
    );
  });

  it("rejects duplicate channel instance ids", async () => {
    const firstRunId = await makeRun();
    const secondRunId = await makeRun();
    await db.insert(runnerInstances).values({ runId: firstRunId, channelInstanceId: INSTANCE_ID });

    await expect(
      db.insert(runnerInstances).values({ runId: secondRunId, channelInstanceId: INSTANCE_ID })
    ).rejects.toThrow();
  });

  it("scopes command sequence uniqueness by controller epoch", async () => {
    const runId = await makeRun();
    await db
      .insert(workerChannelCommands)
      .values(commandValues(runId, "00000000-0000-0000-0000-000000000001", 1, 7));

    await expect(
      db
        .insert(workerChannelCommands)
        .values(commandValues(runId, "00000000-0000-0000-0000-000000000002", 1, 7))
    ).rejects.toThrow();

    await db
      .insert(workerChannelCommands)
      .values(commandValues(runId, "00000000-0000-0000-0000-000000000003", 2, 7));
    const rows = await db
      .select()
      .from(workerChannelCommands)
      .where(eq(workerChannelCommands.runId, runId));
    expect(rows).toHaveLength(2);
  });

  it("rejects duplicate worker sequence numbers for an instance", async () => {
    const runId = await makeRun();
    await db.insert(workerChannelReceipts).values({
      id: "10000000-0000-0000-0000-000000000001",
      runId,
      instanceId: INSTANCE_ID,
      workerSeq: 9,
      controllerEpoch: 1,
      type: "run.finished",
      payloadSha256: "hash-a",
    });

    await expect(
      db.insert(workerChannelReceipts).values({
        id: "10000000-0000-0000-0000-000000000002",
        runId,
        instanceId: INSTANCE_ID,
        workerSeq: 9,
        controllerEpoch: 2,
        type: "run.finished",
        payloadSha256: "hash-b",
      })
    ).rejects.toThrow();
  });

  it("cascades commands and receipts when their run is deleted", async () => {
    const runId = await makeRun();
    const commandId = "20000000-0000-0000-0000-000000000001";
    await db.insert(workerChannelCommands).values(commandValues(runId, commandId, 1, 1));
    await db.insert(workerChannelReceipts).values({
      id: "20000000-0000-0000-0000-000000000002",
      runId,
      instanceId: INSTANCE_ID,
      workerSeq: 1,
      controllerEpoch: 1,
      type: "tool.result",
      payloadSha256: "hash",
      resultCommandId: commandId,
    });

    await db.delete(agentSessions).where(eq(agentSessions.id, runId));

    expect(
      await db.select().from(workerChannelCommands).where(eq(workerChannelCommands.runId, runId))
    ).toHaveLength(0);
    expect(
      await db.select().from(workerChannelReceipts).where(eq(workerChannelReceipts.runId, runId))
    ).toHaveLength(0);
  });
});
