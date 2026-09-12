// __tests__/run-dispatch.test.ts
import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create, get } from "../lib/runs";
import { localSocketPath } from "../lib/worker-channel/dispatch-env";
import {
  dispatchRun,
  provisionLocalChannel,
  provisionSpritesChannel,
  stopRunner,
  unsupportedWsProviderMessage,
} from "../lib/run-dispatch";
import {
  __resetRunnerProviderForTests,
  __setRunnerProviderForTests,
  type RunnerProvider,
} from "../lib/runner/provider";

describe("dispatchRun", () => {
  it("claims an unclaimed run and calls spawn once", async () => {
    const run = await create({ goal: "<implement>", taskId: null as any, defer: true });
    const spawn = vi.fn(() => 5555);
    const result = await dispatchRun(run.id, { spawn });
    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    const row = (await get(run.id))!;
    expect(row.status).toBe("preparing");
    expect(row.workerScope).toMatch(/^server-.*@dispatch-\d+-/);
  });

  it("is idempotent — a second dispatch does not spawn again", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await dispatchRun(run.id, { spawn: () => 1 });
    const spawn2 = vi.fn(() => 2);
    expect(await dispatchRun(run.id, { spawn: spawn2 })).toBe("already-claimed");
    expect(spawn2).not.toHaveBeenCalled();
  });

  it("returns not-found for a missing run", async () => {
    expect(await dispatchRun(999999, { spawn: () => 1 })).toBe("not-found");
  });

  it("does not dispatch a run whose worker is observably alive", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "running" })
      .where(eq(agentSessions.id, run.id));
    installFakeRunnerProvider();
    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "w1" }, "w1");
    expect(await dispatchRun(run.id, { spawn: () => 1 })).toBe("already-claimed");
  });

  // Regression: a spawn that throws (bad module resolution in the prod bundle —
  // the 'Cannot find module tsx/cli' incident) must fail the run, not wedge it
  // in 'preparing' with no error and no worker.
  it("marks the run failed (not wedged in preparing) when spawn throws", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, {
      spawn: () => {
        throw new Error("boom-tsx");
      },
    });
    expect(result).toBe("spawn-failed");
    const row = (await get(run.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/boom-tsx/);
    expect(row.workerScope).toBeNull(); // claim released for retry
  });

  it("marks the run failed when spawn returns no pid (executable not found)", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, { spawn: () => null });
    expect(result).toBe("spawn-failed");
    const row = (await get(run.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/did not start/);
  });

  // Regression (run 58): reviving a failed/completed run for a follow-up turn or
  // restart must clear the PRIOR attempt's terminal artifacts. Otherwise the
  // freshly-claimed, now-running row still carries a stale `error` and a past
  // `completed_at`, so a live run reads as failed in the UI.
  it("clears a prior attempt's error and completed_at when it re-claims the run", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    // Simulate a run that failed a previous turn.
    await db
      .update(agentSessions)
      .set({ status: "failed", error: "Interrupted by a process restart", completedAt: new Date() })
      .where(eq(agentSessions.id, run.id));

    const result = await dispatchRun(run.id, { spawn: () => 4242 });
    expect(result).toBe("spawned");
    const row = (await get(run.id))!;
    expect(row.status).toBe("preparing");
    expect(row.error).toBeNull();
    expect(row.completedAt).toBeNull();
  });
});

describe("stopRunner generation guard", () => {
  it("filters optional generation identity and stops the current row by run id", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "local",
      spriteName: "reusable-runner",
      state: "running",
      generationState: "active",
      workerGeneration: 4,
      channelInstanceId: "wi_44444444444444444444444444444444",
    });
    const destroyGeneration = vi.fn(async () => {});
    const provider: RunnerProvider = {
      kind: "local",
      create: vi.fn(async () => null),
      stop: vi.fn(async () => {}),
      sweep: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({ status: "unknown" as const })),
      destroyGeneration,
    };
    __setRunnerProviderForTests(provider);
    try {
      await stopRunner("reusable-runner", { runId: run.id, workerGeneration: 3 });
      await stopRunner("reusable-runner", { runId: run.id, instanceId: "wi_stale" });
      expect(destroyGeneration).not.toHaveBeenCalled();

      await stopRunner("reusable-runner", { runId: run.id });
      expect(destroyGeneration).toHaveBeenCalledWith(expect.objectContaining({
        runId: run.id,
        generation: 4,
        instanceId: "wi_44444444444444444444444444444444",
        providerHandle: "reusable-runner",
      }));
    } finally {
      __resetRunnerProviderForTests();
    }
  });

  it("does not fall back to a stale scope after a Sprite binding is detached", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: null,
      state: "gone",
      generationState: "stopped",
      workerGeneration: 2,
    });
    const stop = vi.fn(async () => {});
    const destroyGeneration = vi.fn(async () => {});
    __setRunnerProviderForTests({
      kind: "sprites",
      create: vi.fn(async () => null),
      stop,
      sweep: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({ status: "unknown" as const })),
      destroyGeneration,
    });
    try {
      await stopRunner("recycled-sprite", { runId: run.id });
      expect(destroyGeneration).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      __resetRunnerProviderForTests();
    }
  });
});

describe("provisionLocalChannel", () => {
  it("reserves the dial endpoint and derives matching local endpoints", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const channel = await provisionLocalChannel(run.id);

    const expectedSocket = localSocketPath(channel.instanceId);
    expect(channel.instanceId).toMatch(/^wi_[a-f0-9]{32}$/);
    expect(channel.socketPath).toBe(expectedSocket);
    // Worker binds the `unix:` listen form; control plane dials the `ws+unix://` form.
    expect(channel.listenEndpoint).toBe(`unix:${expectedSocket}`);
    expect(channel.dialEndpoint).toBe(`ws+unix://${expectedSocket}:/worker/channel`);

    // A runner_instances row now carries the reserved channel identity + dial endpoint.
    const [row] = await db
      .select()
      .from(runnerInstances)
      .where(eq(runnerInstances.runId, run.id));
    expect(row.channelInstanceId).toBe(channel.instanceId);
    expect(row.channelEndpoint).toBe(channel.dialEndpoint);
    expect(row.provider).toBe("local");
  });

  it("is idempotent for the same instance id", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const first = await provisionLocalChannel(run.id);
    const second = await provisionLocalChannel(run.id, first.instanceId);
    expect(second.dialEndpoint).toBe(first.dialEndpoint);
  });
});

describe("provisionSpritesChannel", () => {
  it("seeds a pending placeholder on first dispatch", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const channel = await provisionSpritesChannel(run.id);
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.channelEndpoint).toBe(`pending:sprites:${channel.instanceId}`);
    expect(channel.listenEndpoint).toBe("tcp:[::]:8787");
  });

  it("keeps the real sprite:// endpoint on a redispatch (run 185 regression)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const first = await provisionSpritesChannel(run.id);
    const real = `sprite://to-run-${run.id}:8787/worker/channel`;
    await db.update(runnerInstances).set({ channelEndpoint: real }).where(eq(runnerInstances.runId, run.id));

    const second = await provisionSpritesChannel(run.id);

    expect(second.instanceId).toBe(first.instanceId);
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.channelEndpoint).toBe(real);
  });
});

describe("unsupportedWsProviderMessage", () => {
  it("is a generic guard now that local/fly/box all provision a WS channel", () => {
    // Every known provider kind has its own dispatch branch; this helper is only
    // reached for a genuinely unknown provider.
    expect(unsupportedWsProviderMessage("mystery")).toBe(
      "Runner provider 'mystery' does not expose a private control-plane-to-worker WebSocket endpoint."
    );
  });
});

// Red-CI incident (2026-07-17): socket paths derived from process.cwd()
// exceeded the kernel's ~108-byte sun_path cap on GitHub runners (110 chars →
// listen EINVAL across the worker-channel suites). The path must be short and
// cwd-independent.
describe("worker socket paths", () => {
  it("fit the kernel sun_path limit and do not depend on cwd", () => {
    const id = `wi_${"a".repeat(32)}`;
    const path = localSocketPath(id);
    expect(path.length).toBeLessThanOrEqual(103);
    expect(path).not.toContain(process.cwd());
    expect(path.endsWith(`${id}.sock`)).toBe(true);
  });
});
