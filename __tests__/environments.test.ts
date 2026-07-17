import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { environments } from "../db/schema";
import {
  listEnvironments,
  markEnvironmentFailed,
  markEnvironmentReady,
  registerConfiguredEnvironments,
  resolveBoxTemplate,
  setTemplateBuildStarter,
} from "../lib/runner/environments";
import { create } from "../lib/runs";

describe("environments schema", () => {
  it("inserts a building row and enforces one live row per provider+sha", async () => {
    const sha = "f".repeat(39) + "1";
    const [row] = await db
      .insert(environments)
      .values({ provider: "box", workerSha: sha, triggeringRunId: 1 })
      .returning();
    expect(row.state).toBe("building");
    await expect(
      db.insert(environments).values({ provider: "box", workerSha: sha })
    ).rejects.toThrow();
  });
});

afterEach(() => {
  delete process.env.TASK_ORCH_BOX_TEMPLATE_ID;
  delete process.env.TASK_ORCH_WORKER_SHA;
  delete process.env.TASK_ORCH_BOX_BUILD_RETRY_COOLDOWN_S;
  setTemplateBuildStarter(null);
});

function sha(n: number): string {
  return n.toString(16).padStart(40, "0");
}

describe("resolveBoxTemplate", () => {
  it("short-circuits to the pinned template without touching the registry", async () => {
    process.env.TASK_ORCH_BOX_TEMPLATE_ID = "bx_pinned";
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const r = await resolveBoxTemplate({ runId: run.id });
    expect(r).toEqual({ kind: "pinned", boxId: "bx_pinned" });
    expect(starter).not.toHaveBeenCalled();
  });

  it("starts a build on miss and returns building with itself as builder", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(101);
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const r = await resolveBoxTemplate({ runId: run.id });
    expect(r).toMatchObject({ kind: "building", builderRunId: run.id, startedNow: true });
    expect(starter).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id, workerSha: sha(101) })
    );
  });

  it("returns the existing build (not a second one) for a concurrent run", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(102);
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const first = await create({ goal: "<implement>", defer: true });
    const second = await create({ goal: "<implement>", defer: true });
    const a = await resolveBoxTemplate({ runId: first.id });
    const b = await resolveBoxTemplate({ runId: second.id });
    expect(a).toMatchObject({ kind: "building", builderRunId: first.id });
    expect(b).toMatchObject({ kind: "building", builderRunId: first.id, startedNow: false });
    expect(starter).toHaveBeenCalledTimes(1);
  });

  it("returns ready once the build is marked ready, and supersedes older ready rows", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(103);
    setTemplateBuildStarter(vi.fn());
    const run = await create({ goal: "<implement>", defer: true });
    const building = await resolveBoxTemplate({ runId: run.id });
    if (building.kind !== "building") throw new Error("expected building");
    await markEnvironmentReady(building.registryId, { boxId: "bx_tpl_103" });
    const r = await resolveBoxTemplate({ runId: run.id });
    expect(r).toMatchObject({ kind: "ready", boxId: "bx_tpl_103", workerSha: sha(103) });

    // New SHA: old ready row is superseded once the new one is ready.
    process.env.TASK_ORCH_WORKER_SHA = sha(104);
    const next = await resolveBoxTemplate({ runId: run.id });
    if (next.kind !== "building") throw new Error("expected building");
    await markEnvironmentReady(next.registryId, { boxId: "bx_tpl_104" });
    const [old] = await db.select().from(environments).where(eq(environments.boxId, "bx_tpl_103"));
    expect(old.state).toBe("superseded");
  });

  it("holds a failed SHA on cooldown instead of rebuilding every tick", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(105);
    process.env.TASK_ORCH_BOX_BUILD_RETRY_COOLDOWN_S = "120";
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const b1 = await resolveBoxTemplate({ runId: run.id });
    if (b1.kind !== "building") throw new Error("expected building");
    await markEnvironmentFailed(b1.registryId, "npm ci exited 1");

    // The immediate next dispatch does NOT start a new build — it reports the
    // cooldown so the run keeps deferring without burning a fresh Box.
    const b2 = await resolveBoxTemplate({ runId: run.id });
    expect(b2).toMatchObject({ kind: "cooldown", error: "npm ci exited 1" });
    expect(starter).toHaveBeenCalledTimes(1); // no second build kicked
  });

  it("rebuilds a failed SHA once the cooldown has elapsed", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(107);
    process.env.TASK_ORCH_BOX_BUILD_RETRY_COOLDOWN_S = "120";
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const b1 = await resolveBoxTemplate({ runId: run.id });
    if (b1.kind !== "building") throw new Error("expected building");
    await markEnvironmentFailed(b1.registryId, "npm ci exited 1");
    // Age the failed row past the cooldown window.
    await db
      .update(environments)
      .set({ createdAt: new Date(Date.now() - 121 * 1000) })
      .where(eq(environments.id, b1.registryId));
    const b2 = await resolveBoxTemplate({ runId: run.id });
    expect(b2).toMatchObject({ kind: "building", startedNow: true });
    expect(b2.kind === "building" && b2.registryId).not.toBe(b1.registryId);
    expect(starter).toHaveBeenCalledTimes(2);
  });

  it("retries a failed SHA immediately when the cooldown is disabled", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(108);
    process.env.TASK_ORCH_BOX_BUILD_RETRY_COOLDOWN_S = "0";
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const b1 = await resolveBoxTemplate({ runId: run.id });
    if (b1.kind !== "building") throw new Error("expected building");
    await markEnvironmentFailed(b1.registryId, "npm ci exited 1");
    const b2 = await resolveBoxTemplate({ runId: run.id });
    expect(b2).toMatchObject({ kind: "building", startedNow: true });
    expect(starter).toHaveBeenCalledTimes(2);
  });

  it("flips an orphaned building row to failed and starts fresh", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(106);
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const b1 = await resolveBoxTemplate({ runId: run.id });
    if (b1.kind !== "building") throw new Error("expected building");
    // Age the row past the orphan threshold (2 × 7 × step budget).
    await db
      .update(environments)
      .set({ createdAt: new Date(Date.now() - 2 * 7 * 900 * 1000 - 60_000) })
      .where(eq(environments.id, b1.registryId));
    const b2 = await resolveBoxTemplate({ runId: run.id });
    expect(b2).toMatchObject({ kind: "building", startedNow: true });
    const [orphan] = await db.select().from(environments).where(eq(environments.id, b1.registryId));
    expect(orphan.state).toBe("failed");
    expect(orphan.error).toMatch(/orphan/i);
  });

  it("provider-scoped single-flight: a docker building row does not block a box build", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(201);
    setTemplateBuildStarter(vi.fn());
    await db.insert(environments).values({ provider: "docker", workerSha: sha(201) }); // building
    const run = await create({ goal: "<implement>", defer: true });
    const r = await resolveBoxTemplate({ runId: run.id });
    expect(r).toMatchObject({ kind: "building", startedNow: true });
  });

  it("registerConfiguredEnvironments upserts docker/fly ready rows idempotently", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(202);
    process.env.TASK_ORCH_WORKER_IMAGE = "task-orchestrator-worker:test";
    process.env.FLY_RUNNER_IMAGE = "registry.fly.io/runners:test";
    try {
      await registerConfiguredEnvironments();
      await registerConfiguredEnvironments(); // idempotent
      const rows = await listEnvironments();
      const mine = rows.filter((r) => r.workerSha === sha(202) && r.state === "ready");
      expect(mine.map((r) => r.provider).sort()).toEqual(["docker", "fly"]);
      expect(mine.find((r) => r.provider === "docker")?.image).toBe("task-orchestrator-worker:test");
    } finally {
      delete process.env.TASK_ORCH_WORKER_IMAGE;
      delete process.env.FLY_RUNNER_IMAGE;
    }
  });

  it("markEnvironmentReady supersedes only same-provider ready rows", async () => {
    const [dockerRow] = await db.insert(environments)
      .values({ provider: "docker", workerSha: sha(203), state: "ready", image: "img:a", readyAt: new Date() }).returning();
    const [boxRow] = await db.insert(environments)
      .values({ provider: "box", workerSha: sha(204) }).returning();
    await markEnvironmentReady(boxRow.id, { boxId: "bx_tpl" });
    const [docker] = await db.select().from(environments).where(eq(environments.id, dockerRow.id));
    expect(docker.state).toBe("ready"); // untouched — different provider
  });
});
