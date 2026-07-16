import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create } from "../lib/runs";
import { acquireControllerLease, persistCommand, rebasePendingCommands } from "../lib/worker-channel/repository";

const instanceId = "wi_0123456789abcdef0123456789abcdef";

describe("worker channel controller persistence", () => {
  beforeEach(async () => { await db.delete(agentSessions); });

  it("fences controllers and replays persisted commands in the new epoch", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db.insert(runnerInstances).values({ runId: run.id, channelInstanceId: instanceId, channelEndpoint: "ws://127.0.0.1:8787/worker/channel" });
    const first = await acquireControllerLease(run.id, "a", new Date("2026-07-16T00:00:00Z"));
    await persistCommand({ runId: run.id, instanceId, controllerEpoch: first.epoch, type: "run.cancel", payload: { reason: "test", requestId: "r", deadline: null } });
    const second = await acquireControllerLease(run.id, "b", new Date("2026-07-16T00:01:00Z"));
    const replay = await rebasePendingCommands(run.id, instanceId, second.epoch);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ controllerEpoch: second.epoch, seq: 1, type: "run.cancel" });
  });
});
