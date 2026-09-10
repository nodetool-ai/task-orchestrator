import { SPRITE_NODE_VERSION } from "../lib/runner/sprites-bootstrap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create } from "../lib/runs";
import {
  buildSpritesWorkerEnv,
  isRunSpriteName,
  SpritesRunnerProvider,
  spriteNameForRun,
  spritesRunnerStateFromStatus,
  workerServiceName,
} from "../lib/runner/sprites";
import { SpritesApiError } from "../lib/runner/sprites-client";
import { workerBundleId } from "../lib/worker-bundle";
import type { SpritesClient } from "../lib/runner/sprites-client";

function fakeSpritesClient(overrides: Partial<SpritesClient> = {}): SpritesClient & { _calls: string[] } {
  const calls: string[] = [];
  const base: SpritesClient = {
    createSprite: vi.fn(async (input: { name: string }) => {
      calls.push(`createSprite:${input.name}`);
      return { name: input.name, status: "running" };
    }),
    getSprite: vi.fn(async (name: string) => {
      calls.push(`getSprite:${name}`);
      return { name, status: "running" };
    }),
    getService: vi.fn(async (_spriteName: string, serviceName: string) => ({
      name: serviceName,
      cmd: "node",
      state: { status: "running", pid: 1, startedAt: "2026-01-01T00:00:00Z" },
    })),
    deleteSprite: vi.fn(async (name: string) => {
      calls.push(`deleteSprite:${name}`);
    }),
    listSprites: vi.fn(async () => ({ sprites: [], continuationToken: undefined })),
    listAllSprites: vi.fn(async () => []),
    putService: vi.fn(async () => {
      calls.push("putService");
    }),
    startService: vi.fn(async () => {
      calls.push("startService");
    }),
    stopService: vi.fn(async () => {
      calls.push("stopService");
    }),
    restartService: vi.fn(async () => {}),
    getServiceLogs: vi.fn(async () => ""),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    checkpoint: vi.fn(async () => ({ id: "cp1" })),
    listCheckpoints: vi.fn(async () => []),
    restoreCheckpoint: vi.fn(async () => {}),
    getNetworkPolicy: vi.fn(async () => null),
    setNetworkPolicy: vi.fn(async () => {
      calls.push("setNetworkPolicy");
    }),
    getResourcesPolicy: vi.fn(async () => null),
    setResourcesPolicy: vi.fn(async () => {}),
    proxyUrl: vi.fn((name: string) => `wss://api.sprites.dev/v1/sprites/${name}/proxy`),
    ...overrides,
  } as SpritesClient;
  (base as unknown as { _calls: string[] })._calls = calls;
  return base as SpritesClient & { _calls: string[] };
}

beforeEach(async () => {
  await db.delete(agentSessions);
  vi.stubEnv("SPRITES_TOKEN", "test-token");
  vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example.com/worker-{sha}.tar.gz");
  vi.stubEnv("TASK_ORCH_WORKER_SHA", "a".repeat(40));
});

afterEach(async () => {
  await db.delete(agentSessions);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("spritesRunnerStateFromStatus", () => {
  it("maps known statuses", () => {
    expect(spritesRunnerStateFromStatus("running")).toBe("running");
    expect(spritesRunnerStateFromStatus("warm")).toBe("starting");
    expect(spritesRunnerStateFromStatus("cold")).toBe("suspended");
    expect(spritesRunnerStateFromStatus("destroyed")).toBe("gone");
    expect(spritesRunnerStateFromStatus("unknown_status_xyz")).toBe("starting");
  });
});

describe("buildSpritesWorkerEnv", () => {
  it("forwards diagnostic settings to worker services", async () => {
    vi.stubEnv("TASK_ORCH_LOG_LEVEL", "debug"); vi.stubEnv("TASK_ORCH_LOG_FORMAT", "json");
    await expect(buildSpritesWorkerEnv(42)).resolves.toMatchObject({ TASK_ORCH_LOG_LEVEL: "debug", TASK_ORCH_LOG_FORMAT: "json" });
  });
  it("defaults Codex to full access inside the isolated Sprite worker", async () => {
    vi.stubEnv("TASK_ORCH_CODEX_SANDBOX", undefined);

    await expect(buildSpritesWorkerEnv(42)).resolves.toMatchObject({
      TASK_ORCH_CODEX_SANDBOX: "danger-full-access",
    });
  });

  it("keeps npm downloads in the persistent Sprite session", async () => {
    await expect(buildSpritesWorkerEnv(42)).resolves.toMatchObject({
      NPM_CONFIG_CACHE: "/home/user/session/.npm-cache",
      NPM_CONFIG_PREFER_OFFLINE: "true",
    });
  });

  it("forwards an explicit Codex sandbox override to the Sprite worker", async () => {
    vi.stubEnv("TASK_ORCH_CODEX_SANDBOX", "workspace-write");

    await expect(buildSpritesWorkerEnv(42)).resolves.toMatchObject({
      TASK_ORCH_CODEX_SANDBOX: "workspace-write",
    });
  });

  it("names worker services by generation and forwards the generation to the worker", async () => {
    expect(workerServiceName(17)).toBe("worker-g17");
    expect(await buildSpritesWorkerEnv(42, { workerGeneration: 17 })).toMatchObject({
      TASK_ORCH_WORKER_GENERATION: "17",
    });
  });
});

describe("SpritesRunnerProvider.inspect", () => {
  it("returns a stable service incarnation and never throws", async () => {
    const provider = new SpritesRunnerProvider(fakeSpritesClient({
      getService: vi.fn(async () => ({ name: "worker", cmd: "node", state: { status: "running", pid: 42, startedAt: "2026-08-27T10:00:00Z" } })),
    }));
    await expect(provider.inspect("to-run-1")).resolves.toEqual({ status: "alive", incarnation: "2026-08-27T10:00:00Z#42", pid: 42 });

    const missing = new SpritesRunnerProvider(fakeSpritesClient({ getSprite: vi.fn(async () => null) }));
    await expect(missing.inspect("to-run-1")).resolves.toEqual({ status: "dead", detail: "sprite gone" });
    const broken = new SpritesRunnerProvider(fakeSpritesClient({ getSprite: vi.fn(async () => { throw new Error("down"); }) }));
    await expect(broken.inspect("to-run-1")).resolves.toEqual({ status: "unknown" });
  });

  it("inspects the generation-specific service instead of the stable worker name", async () => {
    const getService = vi.fn(async (_spriteName: string, serviceName: string) => ({
      name: serviceName,
      cmd: "node",
      state: { status: "running", pid: 17, startedAt: "2026-09-08T10:00:00Z" },
    }));
    const provider = new SpritesRunnerProvider(fakeSpritesClient({ getService }));

    await expect(provider.inspectGeneration({
      runId: 42,
      generation: 17,
      instanceId: "wi_0123456789abcdef0123456789abcdef",
      providerHandle: "to-run-42",
      providerServiceName: "worker-g17",
    })).resolves.toMatchObject({ status: "alive", incarnation: "2026-09-08T10:00:00Z#17" });
    expect(getService).toHaveBeenCalledWith("to-run-42", "worker-g17");
  });

  it("waits for the captured generation service to stop before returning", async () => {
    let stopped = false;
    const stopService = vi.fn(async (_spriteName: string, serviceName: string) => {
      expect(serviceName).toBe("worker-g16");
      stopped = true;
    });
    const getService = vi.fn(async (_spriteName: string, serviceName: string) => ({
      name: serviceName,
      cmd: "node",
      state: { status: stopped ? "stopped" : "running", pid: 16, startedAt: "2026-09-08T09:00:00Z" },
    }));
    const provider = new SpritesRunnerProvider(fakeSpritesClient({ getService, stopService }));

    await provider.stopGeneration({
      runId: 42,
      generation: 16,
      instanceId: "wi_0123456789abcdef0123456789abcdef",
      providerHandle: "to-run-42",
      providerServiceName: "worker-g16",
    });
    expect(stopService).toHaveBeenCalledWith("to-run-42", "worker-g16");
    expect(getService).toHaveBeenCalledWith("to-run-42", "worker-g16");
  });

  it("a hibernating sprite is never dead unless its service proves an exit", async () => {
    const cold = (state: Record<string, unknown>) => new SpritesRunnerProvider(fakeSpritesClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getSprite: vi.fn(async (name: string) => ({ name, status: "cold" })),
      getService: vi.fn(async () => ({ name: "worker", cmd: "node", state }) as any),
    }));
    // Frozen but intact process: alive, same identity.
    await expect(cold({ status: "running", pid: 42, startedAt: "2026-08-27T10:00:00Z" }).inspect("to-run-1"))
      .resolves.toEqual({ status: "alive", incarnation: "2026-08-27T10:00:00Z#42", pid: 42 });
    // Anything else on a cold sprite is unobservable, not a death.
    await expect(cold({ status: "stopped" }).inspect("to-run-1")).resolves.toEqual({ status: "unknown" });
    // The service's own failed verdict is proof of exit.
    await expect(cold({ status: "failed", error: "exited with code 143" }).inspect("to-run-1"))
      .resolves.toEqual({ status: "dead", detail: "exited with code 143" });
    // Supervisor backoff: identity not settled yet.
    await expect(cold({ status: "running", pid: 42, startedAt: "x", nextRestartAt: "2026-08-27T10:01:00Z" }).inspect("to-run-1"))
      .resolves.toEqual({ status: "unknown" });
    // A cold sprite whose service is absent: unknown (a running sprite would be dead).
    const absent = new SpritesRunnerProvider(fakeSpritesClient({
      getSprite: vi.fn(async (name: string) => ({ name, status: "cold" })),
      getService: vi.fn(async () => null),
    }));
    await expect(absent.inspect("to-run-1")).resolves.toEqual({ status: "unknown" });
  });

  it("a destroyed sprite is dead; an unreadable service answer is unknown", async () => {
    const destroyed = new SpritesRunnerProvider(fakeSpritesClient({ getSprite: vi.fn(async (name: string) => ({ name, status: "destroyed" })) }));
    await expect(destroyed.inspect("to-run-1")).resolves.toMatchObject({ status: "dead" });
    const unreadable = new SpritesRunnerProvider(fakeSpritesClient({ getService: vi.fn(async () => { throw new Error("empty body"); }) }));
    await expect(unreadable.inspect("to-run-1")).resolves.toEqual({ status: "unknown" });
  });
});

describe("SpritesRunnerProvider.create", () => {
  it("persists the stable Sprite mapping before boot begins", async () => {
    let releaseBoot!: () => void;
    let enteredBoot!: () => void;
    const bootEntered = new Promise<void>((resolve) => { enteredBoot = resolve; });
    const bootRelease = new Promise<void>((resolve) => { releaseBoot = resolve; });
    const client = fakeSpritesClient({
      createSprite: vi.fn(async (input: { name: string }) => {
        enteredBoot();
        await bootRelease;
        return { name: input.name, status: "running" };
      }),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const operationId = "00000000-0000-4000-8000-000000000001";
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      state: "starting",
      workerGeneration: 4,
      generationState: "allocating",
      providerOperationId: operationId,
      channelInstanceId: "wi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const creating = provider.create({
      runId: run.id,
      scope: `run-${run.id}`,
      workerGeneration: 4,
      providerOperationId: operationId,
      channelInstanceId: "wi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      providerServiceName: "worker-g4",
    });
    await bootEntered;
    const [mapped] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(mapped.spriteName).toBe(spriteNameForRun(run.id));
    expect(mapped.generationState).toBe("booting");
    releaseBoot();
    await creating;
  });

  it("does not create a replacement when Sprite adoption cannot be observed", async () => {
    const createSprite = vi.fn(async (input: { name: string }) => ({ name: input.name, status: "running" }));
    const client = fakeSpritesClient({
      createSprite,
      getSprite: vi.fn(async () => { throw new Error("provider unavailable"); }),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: spriteNameForRun(run.id),
      state: "running",
      workerGeneration: 2,
      providerOperationId: "00000000-0000-4000-8000-000000000002",
    });

    await expect(provider.create({
      runId: run.id,
      scope: `run-${run.id}`,
      workerGeneration: 3,
      providerOperationId: "00000000-0000-4000-8000-000000000003",
      channelInstanceId: "wi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      providerServiceName: "worker-g3",
      previousProviderServiceName: "worker-g2",
      replacesGeneration: 2,
    })).rejects.toThrow("provider unavailable");
    expect(createSprite).not.toHaveBeenCalled();
  });

  it("uses a durable per-run lock across provider instances", async () => {
    let releaseBoot!: () => void;
    let enteredBoot!: () => void;
    const bootEntered = new Promise<void>((resolve) => { enteredBoot = resolve; });
    const bootRelease = new Promise<void>((resolve) => { releaseBoot = resolve; });
    const first = fakeSpritesClient({
      createSprite: vi.fn(async (input: { name: string }) => {
        enteredBoot();
        await bootRelease;
        return { name: input.name, status: "running" };
      }),
    });
    const stopService = vi.fn(async () => {});
    const second = fakeSpritesClient({
      stopService,
      getService: vi.fn(async (spriteName: string, serviceName: string) => ({
        name: serviceName,
        cmd: "node",
        state: { status: "stopped" },
      })),
    });
    const provider1 = new SpritesRunnerProvider(first);
    const provider2 = new SpritesRunnerProvider(second);
    const run = await create({ goal: "<implement>", defer: true });
    const operationId = "00000000-0000-4000-8000-000000000004";
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      state: "starting",
      workerGeneration: 4,
      generationState: "allocating",
      providerOperationId: operationId,
      channelInstanceId: "wi_cccccccccccccccccccccccccccccccc",
      providerServiceName: "worker-g4",
    });
    const creating = provider1.create({
      runId: run.id,
      scope: `run-${run.id}`,
      workerGeneration: 4,
      providerOperationId: operationId,
      channelInstanceId: "wi_cccccccccccccccccccccccccccccccc",
      providerServiceName: "worker-g4",
    });
    await bootEntered;
    const stopping = provider2.stopGeneration({
      runId: run.id,
      generation: 4,
      instanceId: "wi_cccccccccccccccccccccccccccccccc",
      providerHandle: spriteNameForRun(run.id),
      providerServiceName: "worker-g4",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopService).not.toHaveBeenCalled();
    releaseBoot();
    await Promise.all([creating, stopping]);
    expect(stopService).toHaveBeenCalledWith(spriteNameForRun(run.id), "worker-g4");
  });

  it("inserts row with provider sprites and sprite:// endpoint", async () => {
    const client = fakeSpritesClient();
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });

    const ref = await provider.create({ runId: run.id, scope: `run-${run.id}` });

    expect(ref?.handle).toBe(spriteNameForRun(run.id));
    expect(ref?.provider).toBe("sprites");
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.provider).toBe("sprites");
    expect(row.spriteName).toBe(spriteNameForRun(run.id));
    expect(row.channelEndpoint).toBe(`sprite://${spriteNameForRun(run.id)}:8787/worker/channel`);
    expect(row.state).toBe("starting");
    expect(client.createSprite).toHaveBeenCalled();
    expect(client.putService).toHaveBeenCalled();
    expect(client.startService).toHaveBeenCalled();
  });

  it("proceeds without deleteSprite when createSprite throws 409", async () => {
    const deleteSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({
      createSprite: vi.fn(async () => {
        throw new SpritesApiError(409, "already exists");
      }),
      deleteSprite: deleteSpy,
      putService: vi.fn(async () => {}),
      startService: vi.fn(async () => {}),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });

    const ref = await provider.create({ runId: run.id, scope: `run-${run.id}` });

    expect(ref?.handle).toBe(spriteNameForRun(run.id));
    expect(deleteSpy).not.toHaveBeenCalled();
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row).toBeTruthy();
  });

  it("calls deleteSprite once and rethrows when putService throws", async () => {
    const deleteSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({
      createSprite: vi.fn(async (input) => ({ name: input.name, status: "running" })),
      putService: vi.fn(async () => {
        throw new Error("putService failed");
      }),
      deleteSprite: deleteSpy,
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });

    await expect(provider.create({ runId: run.id, scope: `run-${run.id}` })).rejects.toThrow("putService failed");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(spriteNameForRun(run.id));
    // Row should not exist after failed create (rolled back? Actually insert happens after putService, so no row)
    const rows = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(rows).toHaveLength(0);
  });
});

describe("SpritesRunnerProvider.resume", () => {
  it("on cold sprite sets row state to starting and calls startService once", async () => {
    const startSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({
      getSprite: vi.fn(async (name: string) => ({ name, status: "cold" })),
      startService: startSpy,
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "suspended",
      channelInstanceId: "wi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      channelEndpoint: `sprite://${spriteName}:8787/worker/channel`,
    });

    const ref = await provider.resume(run.id);

    expect(ref?.handle).toBe(spriteName);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(spriteName, "worker");
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("starting");
  });

  it("dials sprite://<name> even when the row still holds the dispatch placeholder (run 185)", async () => {
    const client = fakeSpritesClient({ getSprite: vi.fn(async (name: string) => ({ name, status: "warm" })) });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "running",
      channelInstanceId: "wi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      channelEndpoint: "pending:sprites:wi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    const ref = await provider.resume(run.id);

    expect(ref?.channelEndpoint).toBe(`sprite://${spriteName}:8787/worker/channel`);
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.channelEndpoint).toBe(`sprite://${spriteName}:8787/worker/channel`);
  });

  it("redefines the worker service when its baked-in credential is stale (AUTH_SECRET rotation)", async () => {
    const putSpy = vi.fn(async () => {});
    const stopSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({
      getSprite: vi.fn(async (name: string) => ({ name, status: "warm" })),
      getService: vi.fn(async (_s: string, serviceName: string) => ({
        name: serviceName,
        cmd: "node",
        env: { TASK_ORCH_WORKER_CHANNEL_CREDENTIAL: "wc1.wi_cccccccccccccccccccccccccccccccc.stale" },
        state: { status: "running", pid: 7, startedAt: "2026-01-01T00:00:00Z" },
      })),
      putService: putSpy,
      stopService: stopSpy,
      listCheckpoints: vi.fn(async () => [{ id: "cp", comment: `bootstrap ${await workerBundleId()} node ${SPRITE_NODE_VERSION}` }]),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "running",
      channelInstanceId: "wi_cccccccccccccccccccccccccccccccc",
      channelEndpoint: `sprite://${spriteName}:8787/worker/channel`,
    });

    await provider.resume(run.id);

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledTimes(1);
    const def = (putSpy.mock.calls[0] as unknown as [string, string, { env: Record<string, string> }])[2];
    expect(def.env.TASK_ORCH_SPRITE_NAME).toBe(spriteName);
    expect(def.env.TASK_ORCH_WORKER_INSTANCE_ID).toBe("wi_cccccccccccccccccccccccccccccccc");
    expect(def.env.TASK_ORCH_WORKER_CHANNEL_CREDENTIAL).toMatch(/^wc1\.wi_cccccccccccccccccccccccccccccccc\./);
  });

  it("leaves the service definition alone when the credential still matches", async () => {
    const putSpy = vi.fn(async () => {});
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    const instanceId = "wi_dddddddddddddddddddddddddddddddd";
    const currentEnv = await buildSpritesWorkerEnv(run.id, {
      channelInstanceId: instanceId,
      channelListenEndpoint: "tcp:[::]:8787",
    });
    const client = fakeSpritesClient({
      getService: vi.fn(async (_s: string, serviceName: string) => ({
        name: serviceName,
        cmd: "node",
        env: { ...currentEnv, TASK_ORCH_SPRITE_NAME: spriteName },
        state: { status: "running", pid: 7, startedAt: "2026-01-01T00:00:00Z" },
      })),
      putService: putSpy,
      listCheckpoints: vi.fn(async () => [{ id: "cp", comment: `bootstrap ${await workerBundleId()} node ${SPRITE_NODE_VERSION}` }]),
    });
    const provider = new SpritesRunnerProvider(client);
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", spriteName, state: "running", channelInstanceId: instanceId });

    await provider.resume(run.id);

    expect(putSpy).not.toHaveBeenCalled();
  });

  it("re-bootstraps and redefines the service when the shipped bundle changed since the sprite was created", async () => {
    const putSpy = vi.fn(async () => {});
    const checkpointSpy = vi.fn(async () => ({ id: "cp2" }));
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    const instanceId = "wi_abababababababababababababababab";
    const { mintChannelCredential } = await import("../lib/worker-channel/credential");
    const client = fakeSpritesClient({
      getService: vi.fn(async (_s: string, serviceName: string) => ({
        name: serviceName,
        cmd: "node",
        env: { TASK_ORCH_WORKER_CHANNEL_CREDENTIAL: mintChannelCredential(run.id, instanceId) },
        state: { status: "running", pid: 7, startedAt: "2026-01-01T00:00:00Z" },
      })),
      putService: putSpy,
      checkpoint: checkpointSpy,
      listCheckpoints: vi.fn(async () => [{ id: "old", comment: "bootstrap deadbeef" }]),
    });
    const provider = new SpritesRunnerProvider(client);
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", spriteName, state: "running", channelInstanceId: instanceId });

    await provider.resume(run.id);

    expect(checkpointSpy).toHaveBeenCalledWith(spriteName, `bootstrap ${await workerBundleId()} node ${SPRITE_NODE_VERSION}`);
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it("when getSprite returns null marks row gone and returns null", async () => {
    const client = fakeSpritesClient({
      getSprite: vi.fn(async () => null),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "running",
    });

    const ref = await provider.resume(run.id);

    expect(ref).toBeNull();
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("gone");
  });
});

describe("SpritesRunnerProvider.stop", () => {
  it("calls deleteSprite, clears workerScope only when it equals sprite name, nulls sdkSessionId", async () => {
    const deleteSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({ deleteSprite: deleteSpy });
    const provider = new SpritesRunnerProvider(client);

    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.update(agentSessions)
      .set({ workerScope: spriteName, sdkSessionId: "sdk-keep-me", status: "running" })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "running",
    });

    await provider.stop(spriteName);

    expect(deleteSpy).toHaveBeenCalledWith(spriteName);
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(session.workerScope).toBeNull();
    expect(session.sdkSessionId).toBeNull();
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("gone");
    expect(row.spriteName).toBeNull();
  });

  it("does not clear workerScope when it does not equal sprite name", async () => {
    const client = fakeSpritesClient();
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.update(agentSessions)
      .set({ workerScope: "other-scope", sdkSessionId: "sdk-123", status: "running" })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "running",
    });

    await provider.stop(spriteName);

    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(session.workerScope).toBe("other-scope");
    expect(session.sdkSessionId).toBeNull();
  });

  it("logs warn and returns when no row matches sprite name", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deleteSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({ deleteSprite: deleteSpy });
    const provider = new SpritesRunnerProvider(client);

    await provider.stop("to-run-9999");

    expect(deleteSpy).toHaveBeenCalledWith("to-run-9999");
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("isRunSpriteName", () => {
  it("matches only prefix + digits", () => {
    expect(isRunSpriteName("to-run-42")).toBe(true);
    expect(isRunSpriteName("to-run-pool-1")).toBe(false);
    expect(isRunSpriteName("to-run-42x")).toBe(false);
    expect(isRunSpriteName("other-42")).toBe(false);
  });

  it("respects custom prefix", () => {
    vi.stubEnv("TASK_ORCH_SPRITE_PREFIX", "custom-");
    expect(isRunSpriteName("custom-123")).toBe(true);
    expect(isRunSpriteName("custom-pool-1")).toBe(false);
    expect(isRunSpriteName("to-run-42")).toBe(false);
  });
});

describe("SpritesRunnerProvider sweep orphan reaper", () => {
  it("deletes only old unprotected run sprites, skips pool and null createdAt", async () => {
    const deleteSpy = vi.fn(async () => {});
    const old = new Date(Date.now() - 20 * 60_000); // 20m old, past 10m grace
    const client = fakeSpritesClient({
      listAllSprites: vi.fn(async () => [
        { name: "to-run-99", status: "running", createdAt: old },
        { name: "to-run-pool-1", status: "running", createdAt: old },
        { name: "to-run-7", status: "running", createdAt: null },
      ]),
      deleteSprite: deleteSpy,
    });
    const provider = new SpritesRunnerProvider(client);

    // No runner rows → protectedNames empty
    await provider.sweep();

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("to-run-99");
  });

  it("respects orphanGraceMs config", async () => {
    vi.stubEnv("TASK_ORCH_SPRITES_ORPHAN_GRACE_MS", String(60 * 60_000)); // 1h
    const deleteSpy = vi.fn(async () => {});
    const old20m = new Date(Date.now() - 20 * 60_000);
    const old2h = new Date(Date.now() - 2 * 60 * 60_000);
    const client = fakeSpritesClient({
      listAllSprites: vi.fn(async () => [
        { name: "to-run-10", status: "running", createdAt: old20m },
        { name: "to-run-11", status: "running", createdAt: old2h },
      ]),
      deleteSprite: deleteSpy,
    });
    const provider = new SpritesRunnerProvider(client);

    await provider.sweep();

    // 20m is within 1h grace → not deleted; 2h is past → deleted
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("to-run-11");
  });

  it("does not reap protected sprite even if orphan-aged", async () => {
    const deleteSpy = vi.fn(async () => {});
    const old = new Date(Date.now() - 20 * 60_000);
    const client = fakeSpritesClient({
      listAllSprites: vi.fn(async () => [{ name: "to-run-55", status: "running", createdAt: old }]),
      deleteSprite: deleteSpy,
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    // Protect to-run-55 via runnerInstances row
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "to-run-55",
      state: "running",
    });

    await provider.sweep();

    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("does not corrupt row when list omits status (skips state reconciliation)", async () => {
    const getSpriteSpy = vi.fn(async (name: string) => null as unknown as { name: string; status: string } | null);
    const client = fakeSpritesClient({
      // List returns minimal entry without status (docs shape)
      listAllSprites: vi.fn(async () => [{ name: "to-run-77" } as unknown as { name: string; status: string; createdAt: Date }]),
      getSprite: getSpriteSpy,
      deleteSprite: vi.fn(async () => {}),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "to-run-77",
      state: "running",
      channelInstanceId: "wi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    // Also set agentSessions to idle so lifecycle would otherwise destroy
    await db.update(agentSessions).set({ status: "idle" }).where(eq(agentSessions.id, run.id));

    await provider.sweep();

    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    // Should NOT have been corrupted to starting; should stay running because sweep skipped
    expect(row.state).toBe("running");
    expect(getSpriteSpy).toHaveBeenCalledWith("to-run-77");
  });

  it("fetches full sprite when list omits status and reconciles correctly", async () => {
    const client = fakeSpritesClient({
      listAllSprites: vi.fn(async () => [{ name: "to-run-78" } as unknown as { name: string; status: string; createdAt: Date }]),
      getSprite: vi.fn(async (name: string) => ({ name, status: "cold", createdAt: new Date() })),
      deleteSprite: vi.fn(async () => {}),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "to-run-78",
      state: "running",
    });

    await provider.sweep();

    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    // cold -> suspended, so row should be updated to suspended
    expect(row.state).toBe("suspended");
  });
});
