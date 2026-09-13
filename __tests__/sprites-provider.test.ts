import { SPRITE_NODE_VERSION } from "../lib/runner/sprites-bootstrap";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentEvents, agentMessages, agentSessions, inboxEvents, runInputs, runTurns, runnerInstances } from "../db/schema";
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
import { dbTransport } from "../lib/worker/db-transport";
import type { SpritesClient } from "../lib/runner/sprites-client";

function fakeSpritesClient(overrides: Partial<SpritesClient> = {}): SpritesClient & { _calls: string[] } {
  const calls: string[] = [];
  const stoppedServices = new Set<string>();
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
      state: stoppedServices.has(serviceName)
        ? { status: "stopped" }
        : { status: "running", pid: 1, startedAt: "2026-01-01T00:00:00Z" },
    })),
    deleteSprite: vi.fn(async (name: string) => {
      calls.push(`deleteSprite:${name}`);
    }),
    listSprites: vi.fn(async () => ({ sprites: [], continuationToken: undefined })),
    listAllSprites: vi.fn(async () => []),
    listServices: vi.fn(async () => []),
    putService: vi.fn(async () => {
      calls.push("putService");
    }),
    startService: vi.fn(async () => {
      calls.push("startService");
    }),
    stopService: vi.fn(async (_spriteName: string, serviceName: string) => {
      calls.push("stopService");
      stoppedServices.add(serviceName);
    }),
    restartService: vi.fn(async () => {}),
    getServiceLogs: vi.fn(async () => ""),
    exec: vi.fn(async (_spriteName: string, input: { cmd: string }) => ({ exitCode: 0, stdout: input.cmd.startsWith("python3 -c") ? "task-orch-process-v1:alive\n" : "", stderr: "" })),
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
    expect(spritesRunnerStateFromStatus("warm")).toBe("suspended");
    expect(spritesRunnerStateFromStatus("cold")).toBe("suspended");
    expect(spritesRunnerStateFromStatus("destroyed")).toBe("gone");
    expect(spritesRunnerStateFromStatus("unknown_status_xyz")).toBe("starting");
  });
});

describe("buildSpritesWorkerEnv", () => {
  it("forwards both the progress watchdog and an explicit disabled hard cap", async () => {
    vi.stubEnv("TASK_ORCH_TURN_TIMEOUT_MS", "0");
    vi.stubEnv("TASK_ORCH_TURN_IDLE_TIMEOUT_MS", "3600000");
    await expect(buildSpritesWorkerEnv(42)).resolves.toMatchObject({ TASK_ORCH_TURN_TIMEOUT_MS: "0", TASK_ORCH_TURN_IDLE_TIMEOUT_MS: "3600000" });
  });
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

describe("idle generation quiescence", () => {
  it.each([null, "worker"])("stops legacy service %s without deleting the Sprite", async (providerServiceName) => {
    let stopped = false;
    const client = fakeSpritesClient({
      getService: vi.fn(async (_sprite: string, name: string) => ({ name, cmd: "node", state: { status: stopped ? "stopped" : "running" } })),
      stopService: vi.fn(async () => { stopped = true; }),
    });
    const run = await create({ goal: "<chat>", defer: true });
    await db.update(agentSessions).set({ status: "idle", workerScope: "to-run-quiesce", sdkSessionId: "sdk-keep" }).where(eq(agentSessions.id, run.id));
    const instanceId = "wi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", spriteName: "to-run-quiesce", providerServiceName, workerGeneration: 1, channelInstanceId: instanceId, channelEndpoint: "sprite://to-run-quiesce:8787/worker/channel", state: "running" });
    const provider = new SpritesRunnerProvider(client);
    await expect(provider.quiesceIdleGeneration({ runId: run.id, generation: 1, instanceId, providerHandle: "to-run-quiesce" })).resolves.toBe(true);
    expect(client.stopService).toHaveBeenCalledWith("to-run-quiesce", "worker");
    expect(client.deleteSprite).not.toHaveBeenCalled();
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(session.workerScope).toBeNull();
    expect(session.sdkSessionId).toBe("sdk-keep");
    const [instance] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(instance.state).toBe("stopped");
  });

  it("stops a failed implementor service without deleting its Sprite or SDK state", async () => {
    const client = fakeSpritesClient({
      getService: vi.fn(async (_sprite: string, name: string) => ({ name, cmd: "node", state: { status: "stopped" } })),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "implement the assigned task", defer: true });
    await db.update(agentSessions).set({ status: "failed", workerScope: "to-run-failed", sdkSessionId: "sdk-failed" }).where(eq(agentSessions.id, run.id));
    const instanceId = "wi_dddddddddddddddddddddddddddddddd";
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", spriteName: "to-run-failed", providerServiceName: "worker", workerGeneration: 1, channelInstanceId: instanceId, channelEndpoint: "sprite://to-run-failed:8787/worker/channel", state: "running" });

    await expect(provider.quiesceIdleGeneration({ runId: run.id, generation: 1, instanceId, providerHandle: "to-run-failed" })).resolves.toBe(true);
    expect(client.stopService).toHaveBeenCalledWith("to-run-failed", "worker");
    expect(client.deleteSprite).not.toHaveBeenCalled();
    const [saved] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(saved.sdkSessionId).toBe("sdk-failed");
  });

  it.each([
    ["legacy pending user message", "legacy-message"],
    ["legacy inbox event", "legacy-event"],
    ["v2 pending input", "v2-input"],
    ["v2 active turn", "v2-turn"],
  ])("refuses to stop when there is %s", async (_label, kind) => {
    const client = fakeSpritesClient();
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<chat>", defer: true });
    await db.update(agentSessions).set({
      status: "idle", deliveryVersion: kind.startsWith("v2") ? 2 : 1,
      workerScope: "to-run-pending",
    }).where(eq(agentSessions.id, run.id));
    const instanceId = "wi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", spriteName: "to-run-pending", providerServiceName: "worker", workerGeneration: 1, channelInstanceId: instanceId, channelEndpoint: "sprite://to-run-pending:8787/worker/channel", state: "running" });
    if (kind === "legacy-message") {
      await db.insert(agentMessages).values({ runId: run.id, role: "user", content: "[]" });
    } else if (kind === "legacy-event") {
      await db.insert(inboxEvents).values({ targetRunId: run.id, type: "run.attempt_finished", sourceKind: "run", payload: {}, status: "pending" });
    } else if (kind === "v2-input") {
      const [message] = await db.insert(agentMessages).values({ runId: run.id, role: "user", content: "[]" }).returning({ id: agentMessages.id });
      await db.insert(runInputs).values({ id: randomUUID(), runId: run.id, messageId: message.id, inputSeq: 1, kind: "user", status: "pending" });
    } else {
      await db.insert(runTurns).values({ id: randomUUID(), runId: run.id, ordinal: 1, state: "active" });
    }
    const result = await provider.quiesceIdleGeneration({ runId: run.id, generation: 1, instanceId, providerHandle: "to-run-pending" });
    expect(result).toBe(false);
    expect(client.stopService).not.toHaveBeenCalled();
  });

  it("holds the run lock while stopping so a racing append waits", async () => {
    let releaseStop!: () => void;
    let stopEntered!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const entered = new Promise<void>((resolve) => { stopEntered = resolve; });
    let stopped = false;
    const client = fakeSpritesClient({
      getService: vi.fn(async (_sprite: string, name: string) => ({ name, cmd: "node", state: { status: stopped ? "stopped" : "running" } })),
      stopService: vi.fn(async () => { stopEntered(); await stopGate; stopped = true; }),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<chat>", defer: true });
    await db.update(agentSessions).set({ status: "idle", workerScope: "to-run-race" }).where(eq(agentSessions.id, run.id));
    const instanceId = "wi_cccccccccccccccccccccccccccccccc";
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", spriteName: "to-run-race", providerServiceName: "worker", workerGeneration: 1, channelInstanceId: instanceId, channelEndpoint: "sprite://to-run-race:8787/worker/channel", state: "running" });

    const quiesce = provider.quiesceIdleGeneration({ runId: run.id, generation: 1, instanceId, providerHandle: "to-run-race" });
    await entered;
    let appended = false;
    const append = dbTransport.appendMessage(run.id, "user", [{ type: "text", text: "racing follow-up" }]).then(() => { appended = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(appended).toBe(false);
    } finally {
      releaseStop();
    }
    await quiesce;
    await append;
    expect(appended).toBe(true);
    expect(client.stopService).toHaveBeenCalledWith("to-run-race", "worker");
  });
});

describe("SpritesRunnerProvider.inspect", () => {
  it.each([295, 298])("detects run %i's stale running service PID on a suspended Sprite", async (runId) => {
    const client = fakeSpritesClient({
      getSprite: vi.fn(async (name: string) => ({ name, status: "suspended" })),
      getService: vi.fn(async () => ({ name: "worker", cmd: "node", state: {
        status: "running", pid: 1452, startedAt: "2026-09-13T00:00:00Z",
      } })),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "task-orch-process-v1:missing\n", stderr: "" })),
    });
    await expect(new SpritesRunnerProvider(client).inspectGeneration({
      runId, generation: 1, instanceId: "wi_0123456789abcdef0123456789abcdef",
      providerHandle: `to-run-${runId}`, storedIncarnation: "2026-09-13T00:00:00Z#1452",
    })).resolves.toEqual({ status: "dead", detail: "service worker reports running but pid 1452 is absent from procfs" });
    expect(client.exec).toHaveBeenCalledWith(`to-run-${runId}`, expect.objectContaining({ timeoutMs: 5_000, maxOutputBytes: 1_024 }));
    expect(client.stopService).not.toHaveBeenCalled();
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it.each([
    ["unreadable procfs", "task-orch-process-v1:unknown\n", 0],
    ["malformed probe response", "", 0],
    ["failed probe", "task-orch-process-v1:missing\n", 1],
  ])("does not trust stale metadata or infer death with %s", async (_label, stdout, exitCode) => {
    const client = fakeSpritesClient({ exec: vi.fn(async () => ({ exitCode: Number(exitCode), stdout: String(stdout), stderr: "" })) });
    await expect(new SpritesRunnerProvider(client).inspect("to-run-295")).resolves.toEqual({ status: "unknown" });
  });

  it("leaves timed-out suspended VM probes unknown", async () => {
    const client = fakeSpritesClient({
      getSprite: vi.fn(async (name: string) => ({ name, status: "cold" })),
      exec: vi.fn(async () => { throw new Error("exec timed out"); }),
    });
    await expect(new SpritesRunnerProvider(client).inspect("to-run-298")).resolves.toEqual({ status: "unknown" });
  });

  it("rejects a reused PID carrying a different channel identity", async () => {
    const client = fakeSpritesClient({ exec: vi.fn(async () => ({ exitCode: 0, stdout: "task-orch-process-v1:replaced\n", stderr: "" })) });
    await expect(new SpritesRunnerProvider(client).inspectGeneration({
      runId: 42, generation: 1, instanceId: "wi_0123456789abcdef0123456789abcdef", providerHandle: "to-run-42",
    })).resolves.toMatchObject({ status: "dead", detail: expect.stringContaining("different worker identity") });
  });

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

  it("treats a missing service as dead only after that generation was observed alive", async () => {
    const provider = new SpritesRunnerProvider(fakeSpritesClient({ getService: vi.fn(async () => null) }));
    const ref = {
      runId: 42,
      generation: 17,
      instanceId: "wi_0123456789abcdef0123456789abcdef",
      providerHandle: "to-run-42",
      providerServiceName: "worker-g17",
    };

    await expect(provider.inspectGeneration(ref)).resolves.toEqual({
      status: "unknown",
      reason: "not-found",
      detail: "service worker-g17 does not exist",
    });
    await expect(provider.inspectGeneration({ ...ref, storedIncarnation: "2026-09-08T10:00:00Z#17" }))
      .resolves.toEqual({
        status: "dead",
        reason: "runner-gone",
        detail: "service worker-g17 disappeared after incarnation 2026-09-08T10:00:00Z#17",
      });
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

  it.each([false, true])("requires descendant quiescence after supervisor metadata stops (populated=%s)", async (populated) => {
    const client = fakeSpritesClient({
      getService: vi.fn(async (_spriteName: string, name: string) => ({
        name, cmd: "python3", args: ["process-supervisor.py", "worker"],
        env: { TASK_ORCH_WORKER_INSTANCE_ID: "wi_0123456789abcdef0123456789abcdef", TASK_ORCH_WORKER_GENERATION: "16" },
        state: { status: "stopped" },
      })),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: `task-orch-process-v1:${populated ? "unknown" : "missing"}\n`, stderr: "" })),
    });
    if (populated) vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_001);
    const stop = new SpritesRunnerProvider(client).stopGeneration({
      runId: 42, generation: 16, instanceId: "wi_0123456789abcdef0123456789abcdef",
      providerHandle: "to-run-42", providerServiceName: "worker-g16",
    });
    if (populated) await expect(stop).rejects.toThrow("did not reach sticky stopped state");
    else await expect(stop).resolves.toBeUndefined();
    expect(client.exec).toHaveBeenCalledWith("to-run-42", expect.objectContaining({ cmd: expect.stringContaining(" 0 ") }));
  });

  it.each([
    ["with a restart timer", "2026-09-11T12:00:00Z"],
    ["without a restart timer", undefined],
  ])("does not accept a failed service %s as sticky-stopped", async (_label, nextRestartAt) => {
    let stops = 0;
    const stopService = vi.fn(async () => { stops += 1; });
    const getService = vi.fn(async (_spriteName: string, serviceName: string) => ({
      name: serviceName,
      cmd: "node",
      state: stops < 2
        ? { status: "failed", ...(nextRestartAt ? { nextRestartAt } : {}) }
        : { status: "stopped" },
    }));
    const provider = new SpritesRunnerProvider(fakeSpritesClient({ getService, stopService }));

    await provider.stopGeneration({
      runId: 42,
      generation: 16,
      instanceId: "wi_0123456789abcdef0123456789abcdef",
      providerHandle: "to-run-42",
      providerServiceName: "worker-g16",
    });

    expect(stopService).toHaveBeenCalledTimes(2);
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
    await expect(absent.inspect("to-run-1")).resolves.toEqual({
      status: "unknown",
      reason: "not-found",
      detail: "service worker does not exist",
    });
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

  it("fails closed when a retained Sprite is absent", async () => {
    const createSprite = vi.fn(async (input: { name: string }) => ({ name: input.name, status: "running" }));
    const client = fakeSpritesClient({ createSprite, getSprite: vi.fn(async () => null) });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: spriteNameForRun(run.id),
      state: "running",
      workerGeneration: 2,
      generationState: "stopped",
      providerOperationId: "00000000-0000-4000-8000-000000000012",
    });

    await expect(provider.create({
      runId: run.id,
      scope: `run-${run.id}`,
      workerGeneration: 3,
      providerOperationId: "00000000-0000-4000-8000-000000000013",
      channelInstanceId: "wi_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      providerServiceName: "worker-g3",
      previousProviderServiceName: "worker-g2",
      replacesGeneration: 2,
    })).rejects.toThrow("refusing to replace its resumable filesystem");
    expect(createSprite).not.toHaveBeenCalled();
    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id)))[0].spriteName)
      .toBe(spriteNameForRun(run.id));
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
  it("quiesces every older owned worker before defining a replacement", async () => {
    const operationId = "00000000-0000-4000-8000-000000000050";
    const instanceId = "wi_50505050505050505050505050505050";
    const states = new Map<string, { status: string; nextRestartAt?: string }>([
      ["worker", { status: "running" }],
      ["worker-g44", { status: "running" }],
      ["worker-g45", { status: "stopped" }],
      ["worker-g46", { status: "failed", nextRestartAt: "2026-09-11T12:00:00Z" }],
      ["worker-g49", { status: "failed" }],
      ["postgres", { status: "running" }],
    ]);
    const order: string[] = [];
    const services = () => [...states].map(([name, state]) => ({ name, cmd: "node", state: { ...state } }));
    const client = fakeSpritesClient({
      getSprite: vi.fn(async (name: string) => ({ name, status: "warm" })),
      listServices: vi.fn(async () => services()),
      getService: vi.fn(async (_spriteName: string, serviceName: string) => {
        const state = states.get(serviceName);
        return state ? { name: serviceName, cmd: "node", state: { ...state } } : null;
      }),
      stopService: vi.fn(async (_spriteName: string, serviceName: string) => {
        order.push(`stop:${serviceName}`);
        if (serviceName === "worker-g49") {
          throw new SpritesApiError(409, "service is not running");
        }
        if (states.has(serviceName)) states.set(serviceName, { status: "stopped" });
      }),
      putService: vi.fn(async (_spriteName: string, serviceName: string) => { order.push(`put:${serviceName}`); }),
      startService: vi.fn(async (_spriteName: string, serviceName: string) => { order.push(`start:${serviceName}`); }),
      listCheckpoints: vi.fn(async () => [{ id: "cp", comment: `bootstrap ${await workerBundleId()} node ${SPRITE_NODE_VERSION}` }]),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "starting",
      workerGeneration: 50,
      generationState: "allocating",
      providerOperationId: operationId,
      providerServiceName: "worker-g50",
      channelInstanceId: instanceId,
    });

    await provider.resume(run.id, {
      runId: run.id,
      scope: `run-${run.id}`,
      workerGeneration: 50,
      providerOperationId: operationId,
      providerServiceName: "worker-g50",
      previousProviderServiceName: "worker-g49",
      replacesGeneration: 49,
      channelInstanceId: instanceId,
    });

    expect(order.filter((entry) => entry.startsWith("stop:") && entry !== "stop:worker-g50"))
      .toEqual(["stop:worker", "stop:worker-g44", "stop:worker-g46", "stop:worker-g49"]);
    expect(order).not.toContain("stop:postgres");
    const putIndex = order.indexOf("put:worker-g50");
    expect(putIndex).toBeGreaterThan(-1);
    for (const name of ["worker", "worker-g44", "worker-g46", "worker-g49"]) {
      expect(order.indexOf(`stop:${name}`)).toBeLessThan(putIndex);
    }
    expect(order.at(-1)).toBe("start:worker-g50");
  });

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
        state: stopSpy.mock.calls.length > 0
          ? { status: "stopped" }
          : { status: "running", pid: 7, startedAt: "2026-01-01T00:00:00Z" },
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
    const stopSpy = vi.fn(async () => {});
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    const instanceId = "wi_abababababababababababababababab";
    const { mintChannelCredential } = await import("../lib/worker-channel/credential");
    const client = fakeSpritesClient({
      getService: vi.fn(async (_s: string, serviceName: string) => ({
        name: serviceName,
        cmd: "node",
        env: { TASK_ORCH_WORKER_CHANNEL_CREDENTIAL: mintChannelCredential(run.id, instanceId) },
        state: stopSpy.mock.calls.length > 0
          ? { status: "stopped" }
          : { status: "running", pid: 7, startedAt: "2026-01-01T00:00:00Z" },
      })),
      stopService: stopSpy,
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
  it("normalizes a terminal runner mapping that has no Sprite", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions).set({ status: "failed", completedAt: new Date() })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: null,
      state: "starting",
      workerGeneration: 2,
      generationState: "failed",
      providerOperationId: "00000000-0000-4000-8000-000000000099",
    });
    const provider = new SpritesRunnerProvider(fakeSpritesClient({ listAllSprites: vi.fn(async () => []) }));

    await provider.sweep();

    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id)))[0])
      .toMatchObject({ state: "gone", spriteName: null, generationState: "stopped", providerOperationId: null });
    const events = await db.select().from(agentEvents).where(eq(agentEvents.sessionId, run.id));
    expect(events.some((event) => event.type === "runner_mapping_reconciled")).toBe(true);
  });

  it("destroys an expired terminal warm Sprite without waking its worker service", async () => {
    vi.stubEnv("TASK_ORCH_RUNNER_TERMINAL_MS", "0");
    const deleteSpy = vi.fn(async () => {});
    const getServiceSpy = vi.fn(async () => {
      throw new Error("terminal cleanup must not wake or inspect the service");
    });
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.update(agentSessions).set({
      status: "completed",
      completedAt: new Date(Date.now() - 60_000),
      sdkSessionId: "sdk-terminal",
    }).where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "starting",
      workerGeneration: 1,
      generationState: "stopped",
      channelInstanceId: "wi_cccccccccccccccccccccccccccccccc",
      workerIncarnation: "2026-01-01T00:00:00Z#1",
    });
    const provider = new SpritesRunnerProvider(fakeSpritesClient({
      listAllSprites: vi.fn(async () => [{
        name: spriteName,
        status: "warm",
        createdAt: new Date(Date.now() - 60_000),
      }]),
      getService: getServiceSpy,
      deleteSprite: deleteSpy,
    }));

    await provider.sweep();

    expect(getServiceSpy).not.toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith(spriteName);
    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id)))[0])
      .toMatchObject({ state: "gone", spriteName: null, generationState: "stopped" });
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, run.id)))[0]!.sdkSessionId).toBeNull();
  });

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
