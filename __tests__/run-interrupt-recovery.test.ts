import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentEvents, agentMessages, agentSessions, runInputs, runTurns, runnerInstances } from "../db/schema";
import { create, get, interrupt } from "../lib/runs";
import * as dispatch from "../lib/run-dispatch";
import { __setRunnerProviderForTests, type RunnerProvider } from "../lib/runner/provider";

const instanceIdFor = (runId: number) => `wi_${runId.toString(16).padStart(32, "0")}`;

describe("detached turn interruption", () => {
  const stopGeneration = vi.fn(async () => undefined);
  const provider: RunnerProvider = {
    kind: "local",
    create: async () => null,
    stop: async () => undefined,
    stopGeneration,
    inspect: async () => ({ status: "unknown" }),
    sweep: async () => undefined,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    stopGeneration.mockClear();
    __setRunnerProviderForTests(provider);
  });

  it("stops the exact generation, retires its turn, and dispatches queued follow-up input", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const instanceId = instanceIdFor(run.id);
    const [first, followup] = await db.insert(agentMessages).values([
      { runId: run.id, role: "user", content: JSON.stringify([{ type: "text", text: "first" }]) },
      { runId: run.id, role: "user", content: JSON.stringify([{ type: "text", text: "follow up" }]) },
    ]).returning({ id: agentMessages.id });
    const turnId = randomUUID();
    const assignedId = randomUUID();
    const pendingId = randomUUID();
    await db.insert(runTurns).values({
      id: turnId, runId: run.id, ordinal: 1, state: "active",
      inputManifest: [{ id: assignedId }], executionGeneration: 3,
    });
    await db.insert(runInputs).values([
      { id: assignedId, runId: run.id, inputSeq: 1, messageId: first.id, kind: "user", status: "assigned", assignedTurnId: turnId },
      { id: pendingId, runId: run.id, inputSeq: 2, messageId: followup.id, kind: "user", status: "pending" },
    ]);
    await db.update(agentSessions).set({ status: "running", workerScope: "process-g3", sdkSessionId: "sdk-keep" }).where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id, provider: "local", state: "running", generationState: "active",
      workerGeneration: 3, channelInstanceId: instanceId, channelEndpoint: "ws://worker",
      providerServiceName: "worker-g3",
    });
    const dispatchSpy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");

    expect(await interrupt(run.id)).toBe(true);

    expect(stopGeneration).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id, generation: 3, instanceId, processHandle: "process-g3",
    }));
    const after = await get(run.id);
    expect(after?.status).toBe("pending");
    expect(after?.workerScope).toBeNull();
    expect(after?.sdkSessionId).toBe("sdk-keep");
    const [turn] = await db.select().from(runTurns).where(eq(runTurns.id, turnId));
    expect(turn.state).toBe("superseded");
    const inputs = await db.select().from(runInputs).where(eq(runInputs.runId, run.id));
    expect(inputs.find((row) => row.id === assignedId)?.status).toBe("cancelled");
    expect(inputs.find((row) => row.id === pendingId)?.status).toBe("pending");
    expect(dispatchSpy).toHaveBeenCalledWith(run.id);
    const [runner] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(runner.generationState).toBe("stopped");
    expect(runner.workerGeneration).toBe(3);
    expect((await db.select().from(agentEvents).where(eq(agentEvents.sessionId, run.id)))
      .some((event) => event.type === "status" && event.payload.includes('"interrupted":true'))).toBe(true);
  });

  it("fails closed when generation shutdown is not confirmed", async () => {
    stopGeneration.mockRejectedValueOnce(new Error("provider unavailable"));
    const run = await create({ goal: "<implement>", defer: true });
    const instanceId = instanceIdFor(run.id);
    await db.update(agentSessions).set({ status: "running", workerScope: "process-g1" }).where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id, provider: "local", state: "running", generationState: "active",
      workerGeneration: 1, channelInstanceId: instanceId, channelEndpoint: "ws://worker",
    });

    await expect(interrupt(run.id)).rejects.toThrow("provider unavailable");
    expect((await get(run.id))?.status).toBe("running");
    expect((await get(run.id))?.workerScope).toBe("process-g1");
  });
});
