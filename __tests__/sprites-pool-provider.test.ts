import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentSessions, repositories, spritePoolEntries, users } from "@/db/schema";
import { runnerInstances } from "@/db/schema";
import { create } from "@/lib/runs";
import { SpritesRunnerProvider, spriteNameForRun } from "@/lib/runner/sprites";
import { SpriteCapacityError } from "@/lib/runner/sprites-capacity";
import { workerBundleId } from "@/lib/worker-bundle";
import { createDatabaseSpritePoolStore, requestSpritePoolMaintenance, requestSpritePoolRefill, SpritePoolManager } from "@/lib/runner/sprites-pool";
import { spritesPoolStore } from "@/lib/runner/sprites-pool-store";
import type { SpritesClient } from "@/lib/runner/sprites-client";
import { spriteNodeSetupCommand } from "@/lib/runner/sprites-bootstrap";
import { baselineFingerprint, controlledNpmCiCommand, dependencyFingerprint, SPRITE_NPM_CACHE_PATH } from "@/lib/runner/sprites-baseline";
import { getConfiguredSpriteBaselines } from "@/lib/runner/sprites-pool-config";

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
    const refill = requestSpritePoolRefill(c, { baseline: manifest, workerSha: manifest.workerBundleSha, bundleUrl: "https://example/worker.tgz", swapMb: 4096 });
    const fingerprint = baselineFingerprint(manifest);
    const result = await refill!({ reservation: { id: "r", fingerprint, leaseToken: "l", spriteName: "pool-fp", baselineManifest: manifest } });
    expect(vi.mocked(c.exec).mock.calls.map(([, input]) => input.cmd)).toContain(spriteNodeSetupCommand(manifest.nodeVersion));
    expect(result).toEqual({ spriteName: "pool-fp", checkpointId: "checkpoint-real" });
    expect(c.checkpoint).toHaveBeenCalledWith("pool-fp", expect.stringContaining("baseline"));
    const commands = (c.exec as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    expect(commands.length).toBeGreaterThan(0);
    const commandText = vi.mocked(c.exec).mock.calls.map(([, input]) => input.cmd);
    expect(commandText.findIndex((command) => command.includes("task-orchestrator.swap")))
      .toBeLessThan(commandText.findIndex((command) => command === spriteNodeSetupCommand(manifest.nodeVersion)));
  });

  it("rejects a refill whose reservation does not describe the prepared baseline", async () => {
    const c = client();
    const refill = requestSpritePoolRefill(c, { baseline: manifest, workerSha: manifest.workerBundleSha, bundleUrl: "https://example/worker.tgz", swapMb: 4096 });

    await expect(refill!({ reservation: {
      id: "r", fingerprint: "not-the-baseline", leaseToken: "l", spriteName: "pool-mismatch", baselineManifest: manifest,
    } })).rejects.toThrow("reservation fingerprint differs");
    expect(c.createSprite).not.toHaveBeenCalled();
  });

  it("retires a baseline Sprite when swap cannot be enabled before preparation", async () => {
    const c = client({ exec: vi.fn(async (_name, input) => input.cmd.includes("task-orchestrator.swap")
      ? { exitCode: 1, stdout: "", stderr: "swapon failed" }
      : { exitCode: 0, stdout: "", stderr: "" }) });
    const fingerprint = baselineFingerprint(manifest);
    const refill = requestSpritePoolRefill(c, {
      baseline: manifest,
      workerSha: manifest.workerBundleSha,
      bundleUrl: "https://example/worker.tgz",
      swapMb: 4096,
    });

    await expect(refill!({ reservation: {
      id: "r", fingerprint, leaseToken: "l", spriteName: "pool-no-swap", baselineManifest: manifest,
    } })).rejects.toThrow("configure-swap failed");
    expect(c.createSprite).toHaveBeenCalledTimes(1);
    expect(c.deleteSprite).toHaveBeenCalledWith("pool-no-swap");
    expect(c.checkpoint).not.toHaveBeenCalled();
    expect(c.exec).toHaveBeenCalledTimes(1);
  });

  it("prepares one repository baseline and claims its same-Sprite checkpoint with a dependency receipt", async () => {
    const workerSha = await workerBundleId();
    const repositoryId = `R-pool-${crypto.randomUUID()}`;
    const remote = "https://github.com/acme/preinstalled.git";
    const revision = "b".repeat(40);
    const digest = "c".repeat(64);
    const [user] = await db.insert(users).values({ email: `pool-${crypto.randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(repositories).values({ id: repositoryId, name: "preinstalled", remote });
    const dependency = {
      repository: remote,
      revision,
      lockfile: { path: "package-lock.json", sha256: digest },
      packageManifests: [{ path: "package.json", sha256: digest }],
      packageManager: "npm" as const,
      packageManagerVersion: "10.9.8",
      installOptions: ["--no-audit", "--no-fund"],
      setupCommands: ["./scripts/setup-fixture.sh"],
      buildCommands: ["npm run build:fixture"],
      readinessCommands: ["npm run ready:fixture"],
      minimumGitHistoryDepth: 2,
      baseRef: "origin/main",
    };
    const declaredManifest = {
      ...manifest,
      workerBundleSha: workerSha,
      nodeVersion: process.version,
      architecture: process.arch as "x64" | "arm64",
      systemToolsVersion: "sprite-base-v1",
      dependency,
    };
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "1");
    vi.stubEnv("SPRITES_TOKEN", "test-token");
    vi.stubEnv("GH_TOKEN", "test-gh-token");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("TASK_ORCH_RUNNER", "sprites");
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example/worker.tgz");
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([{
      manifest: declaredManifest,
      target: 1,
      repositoryId,
      allowedUserIds: [user.id],
    }]));
    // Use the same hydrated manifest the production claim path computes. This
    // covers the default reuse policy and install-runtime receipt fields rather
    // than preparing a subtly different pre-normalization fingerprint.
    const [configuredBaseline] = getConfiguredSpriteBaselines(workerSha);
    const repositoryManifest = configuredBaseline.manifest;
    const fingerprint = configuredBaseline.fingerprint;
    const c = client();
    const manager = new SpritePoolManager({
      store: createDatabaseSpritePoolStore(),
      target: 1,
      maxSprites: 1,
      fingerprints: () => [fingerprint],
      baseline: () => ({ manifest: repositoryManifest as unknown as Record<string, unknown> }),
      spriteName: () => "pool-repository-ready",
      requestRefill: requestSpritePoolRefill(c, {
        baseline: repositoryManifest,
        workerSha,
        bundleUrl: "https://example/worker.tgz",
        swapMb: 4096,
      }),
    });

    await manager.requestRefill();
    expect(c.checkpoint).toHaveBeenCalledTimes(1);
    expect(c.checkpoint).toHaveBeenCalledWith("pool-repository-ready", `baseline ${fingerprint}`);
    const preparationCommands = vi.mocked(c.exec).mock.calls.map(([, input]) => input.cmd);
    expect(preparationCommands.filter((command) => command.includes(controlledNpmCiCommand(
      SPRITE_NPM_CACHE_PATH, repositoryManifest.dependency!.installOptions,
    )))).toHaveLength(1);
    expect(preparationCommands.some((command) => command.includes(dependency.setupCommands[0]))).toBe(true);
    expect(preparationCommands.some((command) => command.includes(dependency.buildCommands[0]))).toBe(true);
    expect(preparationCommands.some((command) => command.includes(dependency.readinessCommands[0]))).toBe(true);
    expect(preparationCommands.some((command) => command.includes("checkout --detach") && command.includes(revision))).toBe(true);
    const credentialedPreparationCalls = vi.mocked(c.exec).mock.calls.filter(([, input]) => input.env?.GH_TOKEN);
    expect(credentialedPreparationCalls).toHaveLength(1);
    expect(credentialedPreparationCalls[0][1].env).toEqual({ GH_TOKEN: "test-gh-token" });
    expect(vi.mocked(c.exec).mock.calls.every(([, input]) => !input.env?.OPENAI_API_KEY)).toBe(true);

    const run = await create({ goal: "<implement>", repoId: repositoryId, userId: user.id, defer: true });
    const operationId = "00000000-0000-4000-8000-000000000038";
    const instanceId = "wi_55555555555555555555555555555555";
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      state: "starting",
      workerGeneration: 1,
      generationState: "allocating",
      providerOperationId: operationId,
      channelInstanceId: instanceId,
      providerServiceName: "worker-g1",
    });

    await expect(new SpritesRunnerProvider(c).create({
      runId: run.id,
      scope: `run-${run.id}`,
      workerGeneration: 1,
      providerOperationId: operationId,
      channelInstanceId: instanceId,
      providerServiceName: "worker-g1",
    })).resolves.toBeTruthy();

    expect(c.restoreCheckpoint).toHaveBeenCalledTimes(1);
    expect(c.restoreCheckpoint).toHaveBeenCalledWith("pool-repository-ready", "checkpoint-real");
    expect(c.createSprite).toHaveBeenCalledTimes(1);
    expect(c.createSprite).toHaveBeenCalledWith({ name: "pool-repository-ready", urlSettings: { auth: "sprite" } });
    expect(c.putService).toHaveBeenCalledWith("pool-repository-ready", "worker-g1", expect.objectContaining({
      env: expect.objectContaining({
        TASK_ORCH_SPRITE_DEPENDENCY_REUSE: "1",
        TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT: dependencyFingerprint(repositoryManifest.dependency!),
        TASK_ORCH_SPRITE_PACKAGE_MANAGER: "npm",
      }),
    }));
    const [entry] = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.spriteName, "pool-repository-ready"));
    expect(entry).toMatchObject({ state: "claimed", runId: run.id, restoreState: "restored" });
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

  it("does not let a null Sprite mapping block a cold create at the hard cap", async () => {
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "0");
    vi.stubEnv("SPRITES_TOKEN", "test-token");
    vi.stubEnv("TASK_ORCH_RUNNER", "sprites");
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example/worker.tgz");
    const capacityBeforePhantom = await spritesPoolStore.countCapacity();
    // Leave one slot of headroom for a pool refill already queued by a prior
    // test. Three null mappings must still be ignored by the provider's own
    // hard-cap query; counting them would exceed this limit.
    vi.stubEnv("TASK_ORCH_MAX_SPRITES", String(capacityBeforePhantom.total + 2));
    const phantoms = await Promise.all(Array.from({ length: 3 }, () => create({ goal: "<implement>", defer: true })));
    await db.insert(runnerInstances).values(phantoms.map((phantom) => ({
      runId: phantom.id,
      provider: "sprites",
      spriteName: null,
      state: "starting",
      generationState: "stopped",
    })));
    const cold = await create({ goal: "<implement>", defer: true });
    const op = "00000000-0000-4000-8000-000000000037";
    await db.insert(runnerInstances).values({
      runId: cold.id,
      provider: "sprites",
      state: "starting",
      workerGeneration: 1,
      generationState: "allocating",
      providerOperationId: op,
      channelInstanceId: "wi_44444444444444444444444444444444",
      providerServiceName: "worker-g1",
    });
    const c = client();

    await expect(new SpritesRunnerProvider(c).create({
      runId: cold.id,
      scope: `run-${cold.id}`,
      workerGeneration: 1,
      providerOperationId: op,
      channelInstanceId: "wi_44444444444444444444444444444444",
      providerServiceName: "worker-g1",
    })).resolves.toBeTruthy();
    expect(c.createSprite).toHaveBeenCalledWith({
      name: spriteNameForRun(cold.id),
      urlSettings: { auth: "sprite" },
    });
  });
});
