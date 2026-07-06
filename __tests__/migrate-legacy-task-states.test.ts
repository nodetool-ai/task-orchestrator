// __tests__/migrate-legacy-task-states.test.ts
//
// The task state machine dropped `review`/`done`. Existing prod rows carry
// those values in the plain-text tasks.state column, so initDb runs an
// idempotent data migration remapping review→testing and done→merged. This
// exercises it against the real Postgres test instance and asserts it NEVER
// touches the plans table (plan `done` is a separate, still-valid terminal).

import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, migrateLegacyTaskStates } from "../db";
import { eq } from "drizzle-orm";
import { plans, repositories, tasks } from "../db/schema";

beforeEach(async () => {
  await db.delete(tasks);
  await db.delete(plans);
  await db.delete(repositories).where(ne(repositories.id, "R-default"));
});

async function stateOf(id: string): Promise<string> {
  const [row] = await db.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, id));
  return row.state;
}

describe("migrateLegacyTaskStates", () => {
  beforeEach(async () => {
    await db.insert(plans).values({ id: "P-mig", title: "Migration", state: "done" });
    await db.insert(tasks).values([
      { id: "T-review", title: "was review", state: "review", planId: "P-mig" },
      { id: "T-done", title: "was done", state: "done", planId: "P-mig" },
      { id: "T-live", title: "in progress", state: "in_progress", planId: "P-mig" },
    ]);
  });

  it("remaps review→testing and done→merged, leaving other task states alone", async () => {
    await migrateLegacyTaskStates();
    expect(await stateOf("T-review")).toBe("testing");
    expect(await stateOf("T-done")).toBe("merged");
    expect(await stateOf("T-live")).toBe("in_progress");
  });

  it("never touches the plans table (plan `done` survives)", async () => {
    await migrateLegacyTaskStates();
    const [plan] = await db.select({ state: plans.state }).from(plans).where(eq(plans.id, "P-mig"));
    expect(plan.state).toBe("done");
  });

  it("is idempotent — a second run is a no-op", async () => {
    await migrateLegacyTaskStates();
    await migrateLegacyTaskStates();
    expect(await stateOf("T-review")).toBe("testing");
    expect(await stateOf("T-done")).toBe("merged");
  });
});
