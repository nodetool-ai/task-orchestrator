import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { boxTemplates } from "../db/schema";
import {
  markTemplateFailed,
  markTemplateReady,
  resolveBoxTemplate,
  setTemplateBuildStarter,
} from "../lib/runner/box-template-registry";
import { create } from "../lib/runs";

describe("box_templates schema", () => {
  it("inserts a building row and enforces one live row per sha", async () => {
    const sha = "f".repeat(39) + "1";
    const [row] = await db
      .insert(boxTemplates)
      .values({ workerSha: sha, repository: "nodetool-ai/nodetool", triggeringRunId: 1 })
      .returning();
    expect(row.state).toBe("building");
    await expect(
      db.insert(boxTemplates).values({ workerSha: sha, repository: "nodetool-ai/nodetool" })
    ).rejects.toThrow();
  });
});

afterEach(() => {
  delete process.env.TASK_ORCH_BOX_TEMPLATE_ID;
  delete process.env.TASK_ORCH_WORKER_SHA;
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
    await markTemplateReady(building.registryId, "bx_tpl_103");
    const r = await resolveBoxTemplate({ runId: run.id });
    expect(r).toMatchObject({ kind: "ready", boxId: "bx_tpl_103", workerSha: sha(103) });

    // New SHA: old ready row is superseded once the new one is ready.
    process.env.TASK_ORCH_WORKER_SHA = sha(104);
    const next = await resolveBoxTemplate({ runId: run.id });
    if (next.kind !== "building") throw new Error("expected building");
    await markTemplateReady(next.registryId, "bx_tpl_104");
    const { db: dbi } = await import("../db");
    const { boxTemplates: bt } = await import("../db/schema");
    const [old] = await dbi.select().from(bt).where(eq(bt.boxId, "bx_tpl_103"));
    expect(old.state).toBe("superseded");
  });

  it("retries after a failed build with a fresh building row", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(105);
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const b1 = await resolveBoxTemplate({ runId: run.id });
    if (b1.kind !== "building") throw new Error("expected building");
    await markTemplateFailed(b1.registryId, "npm ci exited 1");
    const b2 = await resolveBoxTemplate({ runId: run.id });
    expect(b2).toMatchObject({ kind: "building", startedNow: true });
    expect(b2.kind === "building" && b2.registryId).not.toBe(b1.registryId);
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
    const { db: dbi } = await import("../db");
    const { boxTemplates: bt } = await import("../db/schema");
    await dbi
      .update(bt)
      .set({ createdAt: new Date(Date.now() - 2 * 7 * 900 * 1000 - 60_000) })
      .where(eq(bt.id, b1.registryId));
    const b2 = await resolveBoxTemplate({ runId: run.id });
    expect(b2).toMatchObject({ kind: "building", startedNow: true });
    const [orphan] = await dbi.select().from(bt).where(eq(bt.id, b1.registryId));
    expect(orphan.state).toBe("failed");
    expect(orphan.error).toMatch(/orphan/i);
  });
});
