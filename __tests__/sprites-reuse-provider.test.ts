import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const recycleCompletedSprite = vi.hoisted(() => vi.fn(async () => false));
vi.mock("../lib/runner/sprites-reuse", () => ({ recycleCompletedSprite }));

import { db } from "../db";
import {
  agentSessions,
  repositories,
  runnerInstances,
  spriteBaselineProfiles,
  spritePoolEntries,
  users,
} from "../db/schema";
import { create } from "../lib/runs";
import { SpritesRunnerProvider } from "../lib/runner/sprites";
import { SpriteCapacityError } from "../lib/runner/sprites-capacity";
import type { SpritesClient } from "../lib/runner/sprites-client";
import { getConfiguredSpriteBaselines } from "../lib/runner/sprites-pool-config";
import { workerBundleId } from "../lib/worker-bundle";

function client(overrides: Partial<SpritesClient> = {}): SpritesClient {
  return {
    createSprite: vi.fn(async ({ name }: { name: string }) => ({ name, status: "running" })),
    getSprite: vi.fn(async (name: string) => ({ name, status: "running" })),
    deleteSprite: vi.fn(async () => {}),
    listSprites: vi.fn(async () => ({ sprites: [] })),
    listAllSprites: vi.fn(async () => []),
    getService: vi.fn(async (_spriteName: string, name: string) => ({ name, cmd: "node", state: { status: "stopped" } })),
    listServices: vi.fn(async () => []),
    putService: vi.fn(async () => {}),
    startService: vi.fn(async () => {}),
    stopService: vi.fn(async () => {}),
    restartService: vi.fn(async () => {}),
    getServiceLogs: vi.fn(async () => ""),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    checkpoint: vi.fn(async () => ({ id: "checkpoint" })),
    listCheckpoints: vi.fn(async () => []),
    restoreCheckpoint: vi.fn(async () => {}),
    getNetworkPolicy: vi.fn(async () => null),
    setNetworkPolicy: vi.fn(async () => {}),
    getResourcesPolicy: vi.fn(async () => null),
    setResourcesPolicy: vi.fn(async () => {}),
    proxyUrl: vi.fn(() => "wss://sprite"),
    ...overrides,
  } as unknown as SpritesClient;
}

async function configureReusableRepositoryBaseline(userId: number, repositoryId: string, remote: string) {
  const workerSha = await workerBundleId();
  const digest = "d".repeat(64);
  const dependency = {
    repository: remote,
    revision: "b".repeat(40),
    lockfile: { path: "package-lock.json", sha256: digest },
    packageManifests: [{ path: "package.json", sha256: digest }],
    packageManager: "npm" as const,
    packageManagerVersion: "10.9.8",
    installOptions: ["--no-audit" as const, "--no-fund" as const],
  };
  const declared = {
    schemaVersion: 1 as const,
    workerBundleSha: workerSha,
    nodeVersion: process.version,
    codexVersion: "0.153.4",
    platform: "linux" as const,
    architecture: process.arch as "x64" | "arm64",
    systemToolsVersion: "sprite-base-v1" as const,
    dependency,
  };
  vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "3");
  vi.stubEnv("TASK_ORCH_SPRITE_POOL_REUSE", "1");
  vi.stubEnv("TASK_ORCH_RUNNER", "sprites");
  vi.stubEnv("SPRITES_TOKEN", "test-token");
  vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example.test/worker.tgz");
  vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([{
    manifest: declared,
    target: 3,
    repositoryId,
    allowedUserIds: [userId],
  }]));
  return getConfiguredSpriteBaselines(workerSha)[0];
}

async function createOwnedRun() {
  const repositoryId = `R-reuse-${crypto.randomUUID()}`;
  const remote = `https://github.com/acme/${crypto.randomUUID()}.git`;
  const [user] = await db.insert(users).values({
    email: `reuse-${crypto.randomUUID()}@example.test`,
    passwordHash: "x",
  }).returning();
  await db.insert(repositories).values({ id: repositoryId, name: "reuse fixture", remote });
  const run = await create({ goal: "<implement>", repoId: repositoryId, userId: user.id, defer: true });
  return { run, user, repositoryId, remote };
}

async function insertAllocation(runId: number, generation: number, operationId: string, instanceId: string) {
  await db.insert(runnerInstances).values({
    runId,
    provider: "sprites",
    state: "starting",
    workerGeneration: generation,
    generationState: "allocating",
    providerOperationId: operationId,
    channelInstanceId: instanceId,
    providerServiceName: `worker-g${generation}`,
  });
}

beforeEach(async () => {
  recycleCompletedSprite.mockReset().mockResolvedValue(false);
  await db.delete(spriteBaselineProfiles);
  await db.delete(spritePoolEntries);
  await db.delete(agentSessions);
});

afterEach(async () => {
  await db.delete(spriteBaselineProfiles);
  await db.delete(spritePoolEntries);
  await db.delete(agentSessions);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("reusable Sprite provider integration", () => {
  it("pins a new claim to its owner and repository and isolates the run service", async () => {
    const { run, user, repositoryId, remote } = await createOwnedRun();
    const spec = await configureReusableRepositoryBaseline(user.id, repositoryId, remote);
    const operationId = "00000000-0000-4000-8000-000000000081";
    const instanceId = "wi_81818181818181818181818181818181";
    await insertAllocation(run.id, 5, operationId, instanceId);
    await db.insert(spritePoolEntries).values({
      spriteName: "pool-reusable-claim",
      state: "ready",
      baselineClass: "repository",
      fingerprint: spec.fingerprint,
      baselineManifest: spec.manifest,
      checkpointId: "cp-reusable",
    });
    const c = client();
    const provider = new SpritesRunnerProvider(c);
    vi.spyOn(provider as unknown as { refillPool(): void }, "refillPool").mockImplementation(() => {});

    const result = await provider.create({
      runId: run.id,
      scope: `run-${run.id}`,
      workerGeneration: 5,
      providerOperationId: operationId,
      channelInstanceId: instanceId,
      providerServiceName: "worker-g5",
    });

    const serviceName = `worker-r${run.id}-g5`;
    const sessionRoot = `/home/user/session/runs/${run.id}`;
    expect(result).toMatchObject({ handle: "pool-reusable-claim", providerServiceName: serviceName });
    expect(c.putService).toHaveBeenCalledWith("pool-reusable-claim", serviceName, expect.objectContaining({
      env: expect.objectContaining({
        SESSION_ROOT: sessionRoot,
        TASK_ORCH_SPRITE_RUN_WORKTREE: "1",
        TASK_ORCH_SPRITE_BASELINE_CHECKOUT: "/home/user/session/repo",
      }),
    }));
    expect(c.startService).toHaveBeenCalledWith("pool-reusable-claim", serviceName);
    expect(c.createSprite).not.toHaveBeenCalled();
    const [entry] = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.spriteName, "pool-reusable-claim"));
    expect(entry).toMatchObject({
      state: "claimed",
      runId: run.id,
      reuseUserId: user.id,
      reuseRepositoryId: repositoryId,
    });
    const [mapping] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(mapping).toMatchObject({
      repoPath: `${sessionRoot}/repo`,
      claudePath: `${sessionRoot}/.claude`,
      providerServiceName: serviceName,
    });
  });

  it("queues when its reusable repository pool is exhausted instead of cold-creating", async () => {
    const { run, user, repositoryId, remote } = await createOwnedRun();
    await configureReusableRepositoryBaseline(user.id, repositoryId, remote);
    const operationId = "00000000-0000-4000-8000-000000000082";
    const instanceId = "wi_82828282828282828282828282828282";
    await insertAllocation(run.id, 2, operationId, instanceId);
    const c = client();
    const provider = new SpritesRunnerProvider(c);
    vi.spyOn(provider as unknown as { refillPool(): void }, "refillPool").mockImplementation(() => {});

    await expect(provider.create({
      runId: run.id,
      scope: `run-${run.id}`,
      workerGeneration: 2,
      providerOperationId: operationId,
      channelInstanceId: instanceId,
      providerServiceName: "worker-g2",
    })).rejects.toBeInstanceOf(SpriteCapacityError);
    expect(c.createSprite).not.toHaveBeenCalled();
    expect(c.putService).not.toHaveBeenCalled();
  });

  it("does not let a stale generation stop touch a Sprite reassigned to another run", async () => {
    const old = await createOwnedRun();
    const next = await createOwnedRun();
    await db.insert(runnerInstances).values([
      { runId: old.run.id, provider: "sprites", state: "gone", generationState: "stopped", workerGeneration: 3,
        channelInstanceId: "wi_83838383838383838383838383838383" },
      { runId: next.run.id, provider: "sprites", spriteName: "pool-reassigned", state: "running", generationState: "active",
        workerGeneration: 1, channelInstanceId: "wi_84848484848484848484848484848484", providerServiceName: `worker-r${next.run.id}-g1` },
    ]);
    await db.insert(spritePoolEntries).values({
      spriteName: "pool-reassigned",
      state: "claimed",
      baselineClass: "repository",
      fingerprint: "reassigned-fingerprint",
      baselineManifest: {},
      checkpointId: "cp-reassigned",
      runId: next.run.id,
      reuseUserId: next.user.id,
      reuseRepositoryId: next.repositoryId,
    });
    const c = client();
    const provider = new SpritesRunnerProvider(c);

    await provider.stopGeneration({
      runId: old.run.id,
      generation: 3,
      instanceId: "wi_83838383838383838383838383838383",
      providerHandle: "pool-reassigned",
      providerServiceName: `worker-r${old.run.id}-g3`,
    });

    expect(c.stopService).not.toHaveBeenCalled();
    expect(c.getService).not.toHaveBeenCalled();
    expect(c.deleteSprite).not.toHaveBeenCalled();
  });

  it("delegates a completed pooled run to the recycler during lifecycle sweep", async () => {
    recycleCompletedSprite.mockResolvedValue(true);
    const { run } = await createOwnedRun();
    const instanceId = "wi_85858585858585858585858585858585";
    await db.update(agentSessions).set({ status: "completed", completedAt: new Date() }).where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "pool-completed",
      state: "running",
      generationState: "active",
      workerGeneration: 6,
      channelInstanceId: instanceId,
      providerServiceName: `worker-r${run.id}-g6`,
    });
    await db.insert(spritePoolEntries).values({
      spriteName: "pool-completed",
      state: "claimed",
      baselineClass: "repository",
      fingerprint: "completed-fingerprint",
      baselineManifest: {},
      checkpointId: "cp-completed",
      runId: run.id,
    });
    const c = client({
      listAllSprites: vi.fn(async () => [{ name: "pool-completed", status: "running", createdAt: new Date() }]),
      getService: vi.fn(async (_spriteName: string, name: string) => ({
        name,
        cmd: "node",
        state: { status: "running", pid: 1, startedAt: "2026-09-12T00:00:00Z" },
      })),
    });
    const provider = new SpritesRunnerProvider(c);
    vi.spyOn(provider as unknown as { refillPool(): void }, "refillPool").mockImplementation(() => {});

    await provider.sweep();

    expect(recycleCompletedSprite).toHaveBeenCalledTimes(1);
    expect(recycleCompletedSprite).toHaveBeenCalledWith(c, {
      runId: run.id,
      providerHandle: "pool-completed",
      generation: 6,
      instanceId,
    }, expect.any(Function));
    expect(c.deleteSprite).not.toHaveBeenCalled();
  });
});
