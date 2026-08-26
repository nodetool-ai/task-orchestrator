import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { environments } from "../db/schema";
import {
  listEnvironments,
  markEnvironmentReady,
  registerConfiguredEnvironments,
} from "../lib/runner/environments";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_SHA;
});

function sha(n: number): string {
  return n.toString(16).padStart(40, "0");
}

describe("environments schema", () => {
  it("inserts a building row and enforces one live row per provider+sha", async () => {
    const testSha = "f".repeat(39) + "1";
    const [row] = await db
      .insert(environments)
      .values({ provider: "docker", workerSha: testSha, triggeringRunId: 1 })
      .returning();
    expect(row.state).toBe("building");
    await expect(
      db.insert(environments).values({ provider: "docker", workerSha: testSha })
    ).rejects.toThrow();
  });

  it("provider-scoped single-flight: a docker building row does not block a fly row", async () => {
    await db.insert(environments).values({ provider: "docker", workerSha: sha(201) }); // building
    const [flyRow] = await db
      .insert(environments)
      .values({ provider: "fly", workerSha: sha(201) })
      .returning();
    expect(flyRow.state).toBe("building");
  });
});

describe("environments registry", () => {
  it("registerConfiguredEnvironments upserts only the fly ready row idempotently", async () => {
    // Docker is intentionally NOT pre-registered: TASK_ORCH_WORKER_IMAGE is the
    // host build's target tag, and a ready docker row would 409 the build button.
    process.env.TASK_ORCH_WORKER_SHA = sha(202);
    process.env.TASK_ORCH_WORKER_IMAGE = "task-orchestrator-worker:test";
    process.env.FLY_RUNNER_IMAGE = "registry.fly.io/runners:test";
    try {
      await registerConfiguredEnvironments();
      await registerConfiguredEnvironments(); // idempotent
      const rows = await listEnvironments();
      const mine = rows.filter((r) => r.workerSha === sha(202) && r.state === "ready");
      expect(mine.map((r) => r.provider).sort()).toEqual(["fly"]);
      expect(mine.find((r) => r.provider === "fly")?.image).toBe("registry.fly.io/runners:test");
      expect(mine.some((r) => r.provider === "docker")).toBe(false);
    } finally {
      delete process.env.TASK_ORCH_WORKER_IMAGE;
      delete process.env.FLY_RUNNER_IMAGE;
    }
  });

  it("a late-finishing older build does not supersede a newer ready one", async () => {
    // Race: build A (older row) starts, the SHA drifts, build B (newer row)
    // starts and finishes first, then A finishes last. A must NOT clobber B —
    // the newest artifact stays ready and A demotes itself.
    const [older] = await db.insert(environments)
      .values({ provider: "docker", workerSha: sha(210) }).returning();
    const [newer] = await db.insert(environments)
      .values({ provider: "docker", workerSha: sha(211) }).returning();
    await markEnvironmentReady(newer.id, { image: "img:newer" });
    await markEnvironmentReady(older.id, { image: "img:older" }); // finishes late
    const [a] = await db.select().from(environments).where(eq(environments.id, older.id));
    const [b] = await db.select().from(environments).where(eq(environments.id, newer.id));
    expect(b.state).toBe("ready"); // newest artifact wins
    expect(a.state).toBe("superseded"); // stale-on-arrival, demotes itself
  });

  it("markEnvironmentReady supersedes only same-provider ready rows", async () => {
    const [dockerRow] = await db.insert(environments)
      .values({ provider: "docker", workerSha: sha(203), state: "ready", image: "img:a", readyAt: new Date() }).returning();
    const [flyRow] = await db.insert(environments)
      .values({ provider: "fly", workerSha: sha(204) }).returning();
    await markEnvironmentReady(flyRow.id, { image: "img:fly" });
    const [docker] = await db.select().from(environments).where(eq(environments.id, dockerRow.id));
    expect(docker.state).toBe("ready"); // untouched — different provider
  });
});
