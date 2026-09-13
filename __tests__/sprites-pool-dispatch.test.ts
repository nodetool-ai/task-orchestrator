import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";
import { __setRunnerProviderForTests, __resetRunnerProviderForTests, type CreateRunnerInput, type RunnerProvider } from "../lib/runner/provider";
import { SPRITE_CAPACITY_ERROR_CODE } from "../lib/runner/sprites-capacity";

const previousRunner = process.env.TASK_ORCH_RUNNER;
class BundledSpriteCapacityError extends Error {
  readonly code = SPRITE_CAPACITY_ERROR_CODE;

  constructor() {
    super("Waiting for Sprite capacity.");
    this.name = "SpriteCapacityError";
  }
}
const provider: RunnerProvider = {
  kind: "sprites",
  // Model the production Next.js bundle boundary: the provider's constructor
  // is not the constructor imported by dispatch, but the stable code matches.
  async create() { throw new BundledSpriteCapacityError(); },
  async stop() {}, async sweep() {}, async inspect() { return { status: "unknown" }; },
};

beforeEach(() => { process.env.TASK_ORCH_RUNNER = "sprites"; __setRunnerProviderForTests(provider); });
afterEach(() => { if (previousRunner === undefined) delete process.env.TASK_ORCH_RUNNER; else process.env.TASK_ORCH_RUNNER = previousRunner; __resetRunnerProviderForTests(); });

describe("Sprite dispatch pool boundaries", () => {
  it("preserves an existing pool Sprite name across generation allocation", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", spriteName: `to-run-pool-${run.id}`, state: "stopped" });
    expect(await dispatchRun(run.id, { spawn: () => 1 })).toBe("spawned");
    expect((await db.select({ spriteName: runnerInstances.spriteName }).from(runnerInstances).where(eq(runnerInstances.runId, run.id)))[0]!.spriteName).toBe(`to-run-pool-${run.id}`);
  });

  it("defers capacity errors from a separately bundled constructor and keeps the pending episode timestamp", async () => {
    const started = new Date("2026-01-01T00:00:00Z");
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions).set({ status: "pending", pendingSince: started }).where(eq(agentSessions.id, run.id));
    expect(await dispatchRun(run.id, { providerAdmit: async () => ({ decision: "admit" }) })).toBe("deferred");
    expect((await get(run.id))!).toMatchObject({ status: "pending", pendingSince: started, workerScope: null });
    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id)))[0]).toMatchObject({
      state: "gone",
      spriteName: null,
      generationState: "stopped",
      providerOperationId: null,
      providerServiceName: null,
      channelInstanceId: null,
      channelEndpoint: null,
      workerIncarnation: null,
      controllerId: null,
    });
  });

  it("retries a capacity-only generation without claiming a retained Sprite predecessor", async () => {
    const inputs: CreateRunnerInput[] = [];
    const retryProvider: RunnerProvider = {
      kind: "sprites",
      async create(input) {
        inputs.push(input);
        if (inputs.length === 1) throw new BundledSpriteCapacityError();
        throw new Error("retry reached fresh allocation");
      },
      async stop() {}, async sweep() {}, async inspect() { return { status: "unknown" }; },
    };
    __setRunnerProviderForTests(retryProvider);
    const run = await create({ goal: "<implement>", defer: true });

    expect(await dispatchRun(run.id, { providerAdmit: async () => ({ decision: "admit" }) })).toBe("deferred");
    expect(await dispatchRun(run.id, { providerAdmit: async () => ({ decision: "admit" }) })).toBe("spawn-failed");

    expect(inputs).toHaveLength(2);
    expect(inputs[1].replacesGeneration).toBeUndefined();
    expect(inputs[1].previousProviderServiceName).toBeUndefined();
    expect((await get(run.id))!.error).toContain("retry reached fresh allocation");
  });
});
