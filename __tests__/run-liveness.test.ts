// __tests__/run-liveness.test.ts
//
// The single liveness module: the provider verdict (no clocks) and the shared
// reaper policy that decides re-dispatch / idle / failed.
import { beforeEach, describe, expect, it } from "vitest";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { CONTROLLER_BOOT_ID, decideDeadRunPolicy, isResumableDeadRun, resolveLiveness, serverClaimScope } from "../lib/run-liveness";
import { create, reconcileOrphanedRuns } from "../lib/runs";
import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";
import { __setRunnerProviderForTests, type RunnerProvider } from "../lib/runner/provider";

describe("resolveLiveness", () => {
  beforeEach(() => installFakeRunnerProvider());

  it("distinguishes alive, replaced, unknown, and unowned without clocks", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "unowned" });

    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "same" }, "same");
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "alive", incarnation: "same" });

    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "new" }, "same");
    expect(await resolveLiveness(run.id)).toMatchObject({ verdict: "dead", reason: "replaced" });

    await setFakeRunLiveness(run.id, { status: "unknown" }, "same");
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "unknown" });
  });
});

describe("resolveLiveness — claims that cannot be observed are never unowned", () => {
  beforeEach(() => installFakeRunnerProvider());

  it("a claim with no runner row is unknown (a dispatch may be provisioning it)", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions).set({ workerScope: "to-run-booting" }).where(eq(agentSessions.id, run.id));
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "unknown" });
  });

  it("a runner row with no stored incarnation reports the observation as-is (boot window)", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "booting" }, "placeholder");
    await db.update(runnerInstances).set({ workerIncarnation: null }).where(eq(runnerInstances.runId, run.id));
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "alive", incarnation: "booting" });

    await setFakeRunLiveness(run.id, { status: "dead", detail: "exited with code 1" }, "placeholder");
    await db.update(runnerInstances).set({ workerIncarnation: null }).where(eq(runnerInstances.runId, run.id));
    expect(await resolveLiveness(run.id)).toMatchObject({ verdict: "dead", reason: "exited" });
  });

  it("a claim on a retired provider is dead (runner gone), never unknown", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "x" }, "x");
    await db.update(runnerInstances).set({ provider: "fly" }).where(eq(runnerInstances.runId, run.id));
    expect(await resolveLiveness(run.id)).toMatchObject({ verdict: "dead", reason: "runner-gone" });
  });

  it("a server claim held by THIS process is alive", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const scope = serverClaimScope("nonce-1");
    expect(scope).toContain(CONTROLLER_BOOT_ID);
    await db.update(agentSessions).set({ workerScope: scope }).where(eq(agentSessions.id, run.id));
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "alive", incarnation: scope });
  });

  it("a server claim from a dead process on this host is dead; a foreign host is unknown; legacy is dead", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const { hostname } = await import("node:os");
    // pid 2^22-1 is above the Linux/macOS pid range → observably gone.
    await db.update(agentSessions).set({ workerScope: `server-${hostname()}@4194303@other-boot@n` }).where(eq(agentSessions.id, run.id));
    expect(await resolveLiveness(run.id)).toMatchObject({ verdict: "dead", reason: "exited" });

    await db.update(agentSessions).set({ workerScope: "server-some-other-host@1@boot@n" }).where(eq(agentSessions.id, run.id));
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "unknown" });

    await db.update(agentSessions).set({ workerScope: "server-legacy-nonce" }).where(eq(agentSessions.id, run.id));
    expect(await resolveLiveness(run.id)).toMatchObject({ verdict: "dead", reason: "exited" });
  });
});

describe("resolveLiveness — a run being provisioned by this process", () => {
  it("is alive while its runner row has a provider but no handle yet (run 186)", async () => {
    installFakeRunnerProvider();
    const run = await create({ goal: "<chat>", defer: true });
    // provisionSpritesChannel inserts the row before the sprite exists.
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "starting" });
    await db
      .update(agentSessions)
      .set({ workerScope: serverClaimScope(`dispatch-${run.id}-abc`), status: "preparing" })
      .where(eq(agentSessions.id, run.id));

    expect((await resolveLiveness(run.id)).verdict).toBe("alive");
  });

  it("boot reconciliation preserves a live pre-mapped Sprite after its server claim dies", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const spriteName = `run-${run.id}-sprite`;
    const spriteProvider: RunnerProvider = {
      kind: "sprites",
      async create() { return null; },
      async stop() {},
      async sweep() {},
      async inspect() { return { status: "unknown" }; },
      async inspectGeneration() {
        return { status: "alive", incarnation: "sprite-process-g2" };
      },
    };
    const previousRunner = process.env.TASK_ORCH_RUNNER;
    process.env.TASK_ORCH_RUNNER = "sprites";
    try {
      __setRunnerProviderForTests(spriteProvider);
      await db.update(agentSessions)
        .set({
          status: "running",
          // A dispatcher process that no longer exists. The Sprite mapping below
          // was persisted before its generation finished booting.
          workerScope: `server-${hostname()}@4194303@dead-boot@dispatch`,
        })
        .where(eq(agentSessions.id, run.id));
      await db.insert(runnerInstances).values({
        runId: run.id,
        provider: "sprites",
        spriteName,
        state: "running",
        workerGeneration: 2,
        generationState: "booting",
        providerServiceName: "worker-g2",
      });

      await reconcileOrphanedRuns();

      expect((await db.select({ status: agentSessions.status }).from(agentSessions).where(eq(agentSessions.id, run.id)))[0]?.status)
        .toBe("running");
    } finally {
      if (previousRunner == null) delete process.env.TASK_ORCH_RUNNER;
      else process.env.TASK_ORCH_RUNNER = previousRunner;
    }
  });

  it("declares interrupted provisioning dead when its owner exited before the Sprite service was created", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = `run-${run.id}-sprite`;
    const spriteProvider: RunnerProvider = {
      kind: "sprites",
      async create() { return null; },
      async stop() {},
      async sweep() {},
      async inspect() { return { status: "unknown" }; },
      async inspectGeneration() {
        return { status: "unknown", reason: "not-found", detail: "service worker-g2 does not exist" };
      },
    };
    const previousRunner = process.env.TASK_ORCH_RUNNER;
    process.env.TASK_ORCH_RUNNER = "sprites";
    try {
      __setRunnerProviderForTests(spriteProvider);
      await db.update(agentSessions)
        .set({
          status: "preparing",
          workerScope: `server-${hostname()}@4194303@dead-boot@dispatch`,
        })
        .where(eq(agentSessions.id, run.id));
      await db.insert(runnerInstances).values({
        runId: run.id,
        provider: "sprites",
        spriteName,
        state: "starting",
        workerGeneration: 2,
        generationState: "booting",
        providerServiceName: "worker-g2",
      });

      await expect(resolveLiveness(run.id)).resolves.toMatchObject({
        verdict: "dead",
        reason: "exited",
        detail: expect.stringContaining("worker-g2 does not exist"),
      });
    } finally {
      if (previousRunner == null) delete process.env.TASK_ORCH_RUNNER;
      else process.env.TASK_ORCH_RUNNER = previousRunner;
    }
  });
});

describe("isResumableDeadRun — reconciled existence gate", () => {
  const base = {
    detached: true,
    isImplementWorktree: true,
    hasContinuationState: true,
    hasBranch: true,
    worktreeOnDisk: true,
  };
  it("requires detached + implement-worktree + durable continuation state", () => {
    expect(isResumableDeadRun({ ...base, remote: true })).toBe(true);
    expect(isResumableDeadRun({ ...base, remote: true, detached: false })).toBe(false);
    expect(isResumableDeadRun({ ...base, remote: true, isImplementWorktree: false })).toBe(false);
    expect(isResumableDeadRun({ ...base, remote: true, hasContinuationState: false })).toBe(false);
  });
  it("remote runners check the branch (not the never-present server worktree)", () => {
    expect(isResumableDeadRun({ ...base, remote: true, hasBranch: true, worktreeOnDisk: false })).toBe(true);
    expect(isResumableDeadRun({ ...base, remote: true, hasBranch: false, worktreeOnDisk: true })).toBe(false);
  });
  it("host/dev runs check the on-disk worktree", () => {
    expect(isResumableDeadRun({ ...base, remote: false, worktreeOnDisk: true, hasBranch: false })).toBe(true);
    expect(isResumableDeadRun({ ...base, remote: false, worktreeOnDisk: false, hasBranch: true })).toBe(false);
  });
});

describe("decideDeadRunPolicy — the shared resume policy", () => {
  it("resumable implement run, not OOM → re-dispatch", () => {
    expect(decideDeadRunPolicy({ goal: "implement X", resumable: true, oom: false })).toBe("redispatch");
  });
  it("resumable but OOM-killed → failed (a retry re-kills at the same cap)", () => {
    expect(decideDeadRunPolicy({ goal: "implement X", resumable: true, oom: true })).toBe("failed");
  });
  it("chat run → idle (resumable on the next message)", () => {
    expect(decideDeadRunPolicy({ goal: "<chat>", resumable: false, oom: false })).toBe("idle");
    // OOM chat still idles (the carve-out only blocks a re-dispatch).
    expect(decideDeadRunPolicy({ goal: "<chat>", resumable: false, oom: true })).toBe("idle");
  });
  it("everything else → failed", () => {
    expect(decideDeadRunPolicy({ goal: "<execute>", resumable: false, oom: false })).toBe("failed");
    expect(decideDeadRunPolicy({ goal: "review", resumable: false, oom: false })).toBe("failed");
  });
  it("sweep semantics: oom=false means a resumable orphan always re-dispatches", () => {
    // reconcileOrphanedRuns passes oom=false — its resumable orphans re-dispatch
    // regardless (it has no OOM signal), exactly as before R8.
    expect(decideDeadRunPolicy({ goal: "implement X", resumable: true, oom: false })).toBe("redispatch");
  });
});
