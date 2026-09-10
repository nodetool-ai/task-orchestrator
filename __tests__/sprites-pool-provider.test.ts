import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentSessions, spritePoolEntries } from "@/db/schema";
import { runnerInstances } from "@/db/schema";
import { create } from "@/lib/runs";
import { SpritesRunnerProvider, spriteNameForRun } from "@/lib/runner/sprites";
import { SpriteCapacityError } from "@/lib/runner/sprites-capacity";
import { workerBundleId } from "@/lib/worker-bundle";
import { createDatabaseSpritePoolStore, requestSpritePoolMaintenance, requestSpritePoolRefill, SpritePoolManager } from "@/lib/runner/sprites-pool";
import { spritesPoolStore } from "@/lib/runner/sprites-pool-store";
import type { SpritesClient } from "@/lib/runner/sprites-client";
import { spriteNodeSetupCommand } from "@/lib/runner/sprites-bootstrap";

const manifest = {
  schemaVersion: 1, workerBundleSha: "a".repeat(40), nodeVersion: "v22.0.0", codexVersion: "0.153.4",
  platform: "linux", architecture: "x64", systemToolsVersion: "1",
} as const;

function client(overrides: Partial<SpritesClient> = {}): SpritesClient & { calls: string[] } {
  const calls: string[] = [];
  const c = {
    createSprite: vi.fn(async ({ name }: { name: string }) => ({ name, status: "running" })),
    getSprite: vi.fn(async (name: string) => ({ name, status: "running" })),
    getService: vi.fn(async (_n: string, name: string) => ({ name, cmd: "node", state: { status: "stopped" } })),
    listServices: vi.fn(async () => []),
    deleteSprite: vi.fn(async (name: string) => { calls.push(`delete:${name}`); }),
    listSprites: vi.fn(async () => ({ sprites: [] })), listAllSprites: vi.fn(async () => []),
    putService: vi.fn(async () => { calls.push("put"); }), startService: vi.fn(async () => { calls.push("start"); }),
    stopService: vi.fn(async () => { calls.push("stop"); }), restartService: vi.fn(async () => {}), getServiceLogs: vi.fn(async () => ""),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    checkpoint: vi.fn(async () => ({ id: "checkpoint-real" })), listCheckpoints: vi.fn(async () => []), restoreCheckpoint: vi.fn(async () => {}),
    getNetworkPolicy: vi.fn(async () => null), setNetworkPolicy: vi.fn(async () => {}), getResourcesPolicy: vi.fn(async () => null), setResourcesPolicy: vi.fn(async () => {}),
    proxyUrl: vi.fn(() => "wss://sprite"), ...overrides,
  } as unknown as SpritesClient & { calls: string[] };
  c.calls = calls;
  return c;
}

beforeEach(async () => { await db.delete(spritePoolEntries); await db.delete(agentSessions); });
afterEach(async () => { await db.delete(spritePoolEntries); await db.delete(agentSessions); vi.restoreAllMocks(); });

describe("Sprite pool provider integration", () => {
  it.each([false, true])("reserves foreground priority only for pending runs needing a Sprite (bound=%s)", async (bound) => {
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions).set({ status: "pending", runtime: "worker" }).where(eq(agentSessions.id, run.id));
    if (bound) await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "starting", spriteName: "existing" });
    const manager = new SpritePoolManager({ store: createDatabaseSpritePoolStore(), target: 0 });
    const refill = vi.spyOn(manager, "requestRefill").mockResolvedValue(undefined);
    await requestSpritePoolMaintenance(client(), manager);
    expect(refill).toHaveBeenCalledTimes(bound ? 1 : 0);
  });
  it("prepares and checkpoints only after baseline verification", async () => {
    const c = client();
    const refill = requestSpritePoolRefill(c, { baseline: manifest, workerSha: manifest.workerBundleSha, bundleUrl: "https://example/worker.tgz" });
    const result = await refill!({ reservation: { id: "r", fingerprint: "fp", leaseToken: "l", spriteName: "pool-fp" } });
    expect(vi.mocked(c.exec).mock.calls[1][1].cmd).toBe(spriteNodeSetupCommand(manifest.nodeVersion));
    expect(result).toEqual({ spriteName: "pool-fp", checkpointId: "checkpoint-real" });
    expect(c.checkpoint).toHaveBeenCalledWith("pool-fp", expect.stringContaining("baseline"));
    const commands = (c.exec as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    expect(commands.length).toBeGreaterThan(0);
  });

  it("retries a deleting entry after a provider outage", async () => {
    const [row] = await db.insert(spritePoolEntries).values({ spriteName: "pool-delete", state: "deleting", fingerprint: "fp", baselineManifest: manifest, checkpointId: "cp" }).returning();
    const c = client({ deleteSprite: vi.fn().mockRejectedValueOnce(new Error("outage")).mockResolvedValue(undefined) });
    const manager = new SpritePoolManager({ store: createDatabaseSpritePoolStore(), target: 0 });
    await requestSpritePoolMaintenance(c, manager);
    expect(c.deleteSprite).toHaveBeenCalledTimes(1);
    const [pending] = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.id, row.id));
    expect(pending.state).toBe("deleting");
    await requestSpritePoolMaintenance(c, manager);
    expect(c.deleteSprite).toHaveBeenCalledTimes(2);
    const [deleted] = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.id, row.id));
    expect(deleted.state).toBe("deleted");
  });

  it("does not refill when the configured target is zero", async () => {
    const refill = vi.fn();
    const manager = new SpritePoolManager({ store: createDatabaseSpritePoolStore(), target: 0, requestRefill: refill });
    await manager.requestRefill();
    expect(refill).not.toHaveBeenCalled();
  });

  it("restores a claimed pool Sprite before defining the fresh worker service", async () => {
    const sha = await workerBundleId();
    const pooledManifest = { ...manifest, workerBundleSha: sha, systemToolsVersion: "sprite-base-v1", nodeVersion: process.version, architecture: "x64" };
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "1");
    vi.stubEnv("SPRITES_TOKEN", "test-token");
    vi.stubEnv("TASK_ORCH_RUNNER", "sprites");
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example/worker.tgz");
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([{ manifest: pooledManifest, target: 1 }]));
    const run = await create({ goal: "<implement>", defer: true });
    const op = "00000000-0000-4000-8000-000000000031";
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "starting", workerGeneration: 4, generationState: "allocating", providerOperationId: op, channelInstanceId: "wi_dddddddddddddddddddddddddddddddd", providerServiceName: "worker-g4" });
    await db.insert(spritePoolEntries).values({ spriteName: "pool-ready", state: "ready", fingerprint: (await import("@/lib/runner/sprites-baseline")).baselineFingerprint(pooledManifest), baselineManifest: pooledManifest, checkpointId: "cp-pooled" });
    const c = client({ listServices: vi.fn(async () => []), restoreCheckpoint: vi.fn(async () => {}) });
    const provider = new SpritesRunnerProvider(c);
    await provider.create({ runId: run.id, scope: `run-${run.id}`, workerGeneration: 4, providerOperationId: op, channelInstanceId: "wi_dddddddddddddddddddddddddddddddd", providerServiceName: "worker-g4" });
    expect(c.restoreCheckpoint).toHaveBeenCalledWith("pool-ready", "cp-pooled");
    expect(c.putService).toHaveBeenCalled();
    expect((c.createSprite as ReturnType<typeof vi.fn>).mock.calls.some(([input]) => input.name === spriteNameForRun(run.id))).toBe(false);
    const [instance] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(instance.state).toBe("starting");
  });

  it("does not restore the baseline again when resuming the assigned run", async () => {
    const sha = await workerBundleId();
    const pooledManifest = { ...manifest, workerBundleSha: sha, systemToolsVersion: "sprite-base-v1", nodeVersion: process.version, architecture: "x64" };
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "1");
    vi.stubEnv("SPRITES_TOKEN", "test-token");
    vi.stubEnv("TASK_ORCH_RUNNER", "sprites");
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example/worker.tgz");
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([{ manifest: pooledManifest, target: 1 }]));
    const run = await create({ goal: "<implement>", defer: true });
    const op = "00000000-0000-4000-8000-000000000032";
    const fp = (await import("@/lib/runner/sprites-baseline")).baselineFingerprint(pooledManifest);
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "starting", workerGeneration: 4, generationState: "allocating", providerOperationId: op, channelInstanceId: "wi_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", providerServiceName: "worker-g4", spriteName: "pool-resume" });
    await db.insert(spritePoolEntries).values({ spriteName: "pool-resume", state: "claimed", runId: run.id, restoreState: "restored", fingerprint: fp, baselineManifest: pooledManifest, checkpointId: "cp-resume" });
    const c = client({ listServices: vi.fn(async () => []) });
    const provider = new SpritesRunnerProvider(c);
    await provider.resume(run.id, { runId: run.id, scope: `run-${run.id}`, workerGeneration: 4, providerOperationId: op, channelInstanceId: "wi_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", providerServiceName: "worker-g4" });
    expect(c.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("retires a pool assignment when restore fails without starting a worker", async () => {
    const sha = await workerBundleId();
    const pooledManifest = { ...manifest, workerBundleSha: sha, systemToolsVersion: "sprite-base-v1", nodeVersion: process.version, architecture: "x64" };
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "1");
    vi.stubEnv("SPRITES_TOKEN", "test-token");
    vi.stubEnv("TASK_ORCH_RUNNER", "sprites");
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example/worker.tgz");
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([{ manifest: pooledManifest, target: 1 }]));
    const run = await create({ goal: "<implement>", defer: true });
    const op = "00000000-0000-4000-8000-000000000033";
    const fp = (await import("@/lib/runner/sprites-baseline")).baselineFingerprint(pooledManifest);
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "starting", workerGeneration: 4, generationState: "allocating", providerOperationId: op, channelInstanceId: "wi_ffffffffffffffffffffffffffffffff", providerServiceName: "worker-g4" });
    const [entry] = await db.insert(spritePoolEntries).values({ spriteName: "pool-bad-restore", state: "ready", fingerprint: fp, baselineManifest: pooledManifest, checkpointId: "cp-bad" }).returning();
    const c = client({ restoreCheckpoint: vi.fn(async () => { throw new Error("restore rejected"); }), listServices: vi.fn(async () => []), deleteSprite: vi.fn(async () => {}) });
    const provider = new SpritesRunnerProvider(c);
    await expect(provider.create({ runId: run.id, scope: `run-${run.id}`, workerGeneration: 4, providerOperationId: op, channelInstanceId: "wi_ffffffffffffffffffffffffffffffff", providerServiceName: "worker-g4" })).rejects.toThrow("restore rejected");
    expect(c.putService).not.toHaveBeenCalled();
    expect(c.startService).not.toHaveBeenCalled();
    const [deleted] = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.id, entry.id));
    expect(["deleting", "deleted"]).toContain(deleted.state);
  });

  it("adopts a claimed entry after a crash between claim and provider create", async () => {
    const sha = await workerBundleId();
    const pooledManifest = { ...manifest, workerBundleSha: sha, systemToolsVersion: "sprite-base-v1", nodeVersion: process.version, architecture: "x64" };
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "1");
    vi.stubEnv("SPRITES_TOKEN", "test-token");
    vi.stubEnv("TASK_ORCH_RUNNER", "sprites");
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example/worker.tgz");
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([{ manifest: pooledManifest, target: 1 }]));
    const run = await create({ goal: "<implement>", defer: true });
    const op = "00000000-0000-4000-8000-000000000034";
    const fp = (await import("@/lib/runner/sprites-baseline")).baselineFingerprint(pooledManifest);
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "starting", workerGeneration: 4, generationState: "allocating", providerOperationId: op, channelInstanceId: "wi_11111111111111111111111111111111", providerServiceName: "worker-g4" });
    await db.insert(spritePoolEntries).values({ spriteName: "pool-crash-adopt", state: "ready", fingerprint: fp, baselineManifest: pooledManifest, checkpointId: "cp-adopt" });
    const claimed = await spritesPoolStore.claimForRun({ runId: run.id, fingerprint: fp, expectedWorkerGeneration: 4, expectedProviderOperationId: op });
    expect(claimed?.spriteName).toBe("pool-crash-adopt");
    const c = client({ listServices: vi.fn(async () => []) });
    const provider = new SpritesRunnerProvider(c);
    await provider.create({ runId: run.id, scope: `run-${run.id}`, workerGeneration: 4, providerOperationId: op, channelInstanceId: "wi_11111111111111111111111111111111", providerServiceName: "worker-g4" });
    expect(c.createSprite).not.toHaveBeenCalled();
    expect(c.restoreCheckpoint).toHaveBeenCalledTimes(1);
    expect(c.restoreCheckpoint).toHaveBeenCalledWith("pool-crash-adopt", "cp-adopt");
  });

  it("rejects a cold create at capacity, while a matching ready pool entry is admitted", async () => {
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "0");
    vi.stubEnv("TASK_ORCH_MAX_SPRITES", "1");
    vi.stubEnv("SPRITES_TOKEN", "test-token");
    vi.stubEnv("TASK_ORCH_RUNNER", "sprites");
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example/worker.tgz");
    const occupied = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({ runId: occupied.id, provider: "sprites", spriteName: "occupied", state: "running", generationState: "active" });
    const cold = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({ runId: cold.id, provider: "sprites", state: "starting", workerGeneration: 4, generationState: "allocating", providerOperationId: "00000000-0000-4000-8000-000000000035", channelInstanceId: "wi_22222222222222222222222222222222", providerServiceName: "worker-g4" });
    const coldClient = client();
    await expect(new SpritesRunnerProvider(coldClient).create({ runId: cold.id, scope: `run-${cold.id}`, workerGeneration: 4, providerOperationId: "00000000-0000-4000-8000-000000000035", channelInstanceId: "wi_22222222222222222222222222222222", providerServiceName: "worker-g4" })).rejects.toBeInstanceOf(SpriteCapacityError);
    expect(coldClient.createSprite).not.toHaveBeenCalled();

    const sha = await workerBundleId();
    const pooledManifest = { ...manifest, workerBundleSha: sha, systemToolsVersion: "sprite-base-v1", nodeVersion: process.version, architecture: "x64" };
    const fp = (await import("@/lib/runner/sprites-baseline")).baselineFingerprint(pooledManifest);
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "1");
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([{ manifest: pooledManifest, target: 1 }]));
    const warm = await create({ goal: "<implement>", defer: true });
    const warmOp = "00000000-0000-4000-8000-000000000036";
    await db.insert(runnerInstances).values({ runId: warm.id, provider: "sprites", state: "starting", workerGeneration: 4, generationState: "allocating", providerOperationId: warmOp, channelInstanceId: "wi_33333333333333333333333333333333", providerServiceName: "worker-g4" });
    await db.insert(spritePoolEntries).values({ spriteName: "pool-at-cap", state: "ready", fingerprint: fp, baselineManifest: pooledManifest, checkpointId: "cp-at-cap" });
    const warmClient = client({ listServices: vi.fn(async () => []) });
    await expect(new SpritesRunnerProvider(warmClient).create({ runId: warm.id, scope: `run-${warm.id}`, workerGeneration: 4, providerOperationId: warmOp, channelInstanceId: "wi_33333333333333333333333333333333", providerServiceName: "worker-g4" })).resolves.toBeTruthy();
    expect(warmClient.restoreCheckpoint).toHaveBeenCalledWith("pool-at-cap", "cp-at-cap");
  });
});
