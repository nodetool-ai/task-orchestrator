import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create } from "../lib/runs";
import { connectRun, maybeCloseSpritesChannel, getConnection } from "../lib/worker-channel/registry";
import { ControllerConnection } from "../lib/worker-channel/connection";
import { eq } from "drizzle-orm";

describe("sprites channel close at turn end", () => {
  beforeEach(async () => {
    await db.delete(agentSessions);
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example.com/worker-{sha}.tar.gz");
    vi.stubEnv("TASK_ORCH_WORKER_SHA", "a".repeat(40));
  });
  afterEach(async () => {
    await db.delete(agentSessions);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    // Clean up any supervisors
    const { disconnectRun } = await import("../lib/worker-channel/registry");
    const ids = await db.select({ id: agentSessions.id }).from(agentSessions);
    for (const r of ids) await disconnectRun(r.id).catch(() => {});
  });

  it("closes sprite:// channel when run goes idle, leaves local ws+unix open", async () => {
    // Create two runs: one sprites, one local
    const spritesRun = await create({ goal: "<chat>", defer: true });
    const localRun = await create({ goal: "<chat>", defer: true });

    // Insert channel identities - must use distinct instanceIds due to unique constraint
    const spriteEndpoint = "sprite://to-run-1:8787/worker/channel";
    const localEndpoint = "ws+unix:///tmp/test.sock:/worker/channel";
    const spriteInstanceId = "wi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const localInstanceId = "wi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await db.insert(runnerInstances).values([
      { runId: spritesRun.id, provider: "sprites", spriteName: "to-run-1", state: "running", channelInstanceId: spriteInstanceId, channelEndpoint: spriteEndpoint },
      { runId: localRun.id, provider: "local", state: "running", channelInstanceId: localInstanceId, channelEndpoint: localEndpoint },
    ]);
    // Need to set up channel identity in runner_instances for getChannelIdentity to work
    // getChannelIdentity reads runnerInstances.channelInstanceId and channelEndpoint
    // So the above inserts are sufficient.

    // Mock connections
    const spriteClose = vi.fn(async () => {});
    const localClose = vi.fn(async () => {});
    const spriteConn = {
      connected: true,
      disconnect: spriteClose,
    } as unknown as ControllerConnection;
    const localConn = {
      connected: true,
      disconnect: localClose,
    } as unknown as ControllerConnection;

    // Inject supervisors directly via registry's internal map
    const REGISTRY = Symbol.for("task-orchestrator.worker-channel.registry");
    let registry = (globalThis as unknown as Record<symbol, { supervisors: Map<number, unknown>; blobs: Map<number, unknown>; controllerId: string }>)[REGISTRY] as {
      supervisors: Map<number, { runId: number; instanceId: string; connection: ControllerConnection; stopped: boolean }>;
      blobs: Map<number, unknown>;
      controllerId: string;
    };
    if (!registry) {
      registry = {
        supervisors: new Map(),
        blobs: new Map(),
        controllerId: `test_${Math.random().toString(36).slice(2)}`,
      };
      (globalThis as unknown as Record<symbol, unknown>)[REGISTRY] = registry;
    }
    // Insert supervisors
    registry.supervisors.set(spritesRun.id, { runId: spritesRun.id, instanceId: spriteInstanceId, connection: spriteConn, stopped: false } as unknown as { runId: number; instanceId: string; connection: ControllerConnection; stopped: boolean });
    registry.supervisors.set(localRun.id, { runId: localRun.id, instanceId: localInstanceId, connection: localConn, stopped: false } as unknown as { runId: number; instanceId: string; connection: ControllerConnection; stopped: boolean });

    // Set statuses to idle
    await db.update(agentSessions).set({ status: "idle" }).where(eq(agentSessions.id, spritesRun.id));
    await db.update(agentSessions).set({ status: "idle" }).where(eq(agentSessions.id, localRun.id));

    // Call maybeClose for both
    await maybeCloseSpritesChannel(spritesRun.id);
    await maybeCloseSpritesChannel(localRun.id);

    // Wait for setTimeout 0
    await new Promise((r) => setTimeout(r, 20));

    expect(spriteClose).toHaveBeenCalledTimes(1);
    expect(localClose).not.toHaveBeenCalled();

    // Cleanup
    registry.supervisors.delete(spritesRun.id);
    registry.supervisors.delete(localRun.id);
  });

  it("closes sprite:// channel on parked and terminal, not on running", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const endpoint = "sprite://to-run-2:8787/worker/channel";
    const instanceId = "wi_cccccccccccccccccccccccccccccccc";
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "to-run-2",
      state: "running",
      channelInstanceId: instanceId,
      channelEndpoint: endpoint,
    });
    const close = vi.fn(async () => {});
    const conn = { connected: true, disconnect: close } as unknown as ControllerConnection;
    const REGISTRY = Symbol.for("task-orchestrator.worker-channel.registry");
    let registry = (globalThis as unknown as Record<symbol, { supervisors: Map<number, unknown>; blobs: Map<number, unknown>; controllerId: string }>)[REGISTRY] as {
      supervisors: Map<number, { runId: number; instanceId: string; connection: ControllerConnection; stopped: boolean }>;
      blobs: Map<number, unknown>;
      controllerId: string;
    };
    if (!registry) {
      registry = {
        supervisors: new Map(),
        blobs: new Map(),
        controllerId: `test_${Math.random().toString(36).slice(2)}`,
      };
      (globalThis as unknown as Record<symbol, unknown>)[REGISTRY] = registry;
    }
    registry.supervisors.set(run.id, { runId: run.id, instanceId, connection: conn, stopped: false } as unknown as { runId: number; instanceId: string; connection: ControllerConnection; stopped: boolean });

    // Running should not close
    await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, run.id));
    await maybeCloseSpritesChannel(run.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(close).not.toHaveBeenCalled();

    // Parked should close
    await db.update(agentSessions).set({ status: "parked" }).where(eq(agentSessions.id, run.id));
    await maybeCloseSpritesChannel(run.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(close).toHaveBeenCalledTimes(1);

    // Reset for terminal
    close.mockClear();
    // Need to re-insert supervisor because previous close may have set stopped? Our helper checks stopped, but we set stopped false, so it will still be there, but after first close, supervisor is still there (we didn't delete). For test, we reset stopped.
    const sup = registry.supervisors.get(run.id) as unknown as { stopped: boolean; connection: ControllerConnection };
    if (sup) sup.stopped = false;
    await db.update(agentSessions).set({ status: "completed" }).where(eq(agentSessions.id, run.id));
    await maybeCloseSpritesChannel(run.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(close).toHaveBeenCalledTimes(1);

    registry.supervisors.delete(run.id);
  });
});

describe("connectRun after the sprites idle close (run 187)", () => {
  it("does not reuse a shut-down connection object", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const instanceId = "wi_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "to-run-187",
      state: "running",
      channelInstanceId: instanceId,
      channelEndpoint: "sprite://to-run-187:8787/worker/channel",
    });
    const REGISTRY = Symbol.for("task-orchestrator.worker-channel.registry");
    const registry = ((globalThis as unknown as Record<symbol, unknown>)[REGISTRY] ??= {
      supervisors: new Map(),
      blobs: new Map(),
      controllerId: "test_187",
    }) as { supervisors: Map<number, unknown> };
    const dead = { connected: false, shutDown: true, connect: async () => { throw new Error("controller connection is shut down"); } };
    registry.supervisors.set(run.id, { runId: run.id, instanceId, connection: dead, stopped: true });

    let message = "";
    try {
      await connectRun(run.id);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // A fresh dial fails for a real reason (no SPRITES_TOKEN / no worker), never
    // because the stood-down object was reused.
    expect(message).not.toMatch(/shut down/);
    expect(registry.supervisors.get(run.id)).not.toBe(dead);
  });
});
