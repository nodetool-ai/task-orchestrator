import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { environments } from "../db/schema";
import { markEnvironmentReady } from "../lib/runner/environments";

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

});

describe("environments registry", () => {
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

});
