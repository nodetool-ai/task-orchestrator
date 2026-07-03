import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, plans, tasks } from "../db/schema";
import * as repo from "../lib/repo";
import { seedPersonas } from "../db/seed-personas";

// resolveAttachedRun / attachRunToTask back the one-run-per-task model: a
// pointer on tasks.attached_run_id, with `closed` runs treated as absent.

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
});

let seq = 0;
async function makeTask(): Promise<string> {
  const plan = await repo.createPlan({ title: `Plan ${++seq}`, date: "2026-06-19" });
  return (await repo.createTask({ planId: plan.id, title: `Task ${seq}`, date: "2026-06-19" })).id;
}

async function insertRun(taskId: string, status: string): Promise<number> {
  const row = await db
    .insert(agentSessions)
    .values({ goal: "<implement>", cwdStrategy: "worktree", taskId, status, personaId: "implementor" })
    .returning();
  return row[0].id;
}

describe("resolveAttachedRun / attachRunToTask", () => {
  it("returns null when no run is attached", async () => {
    const taskId = await makeTask();
    expect(await repo.resolveAttachedRun(taskId)).toBeNull();
  });

  it("resolves the attached run after attaching", async () => {
    const taskId = await makeTask();
    const runId = await insertRun(taskId, "completed");
    await repo.attachRunToTask(taskId, runId);
    expect((await repo.resolveAttachedRun(taskId))?.id).toBe(runId);
  });

  it("treats a closed attached run as absent", async () => {
    const taskId = await makeTask();
    const runId = await insertRun(taskId, "closed");
    await repo.attachRunToTask(taskId, runId);
    expect(await repo.resolveAttachedRun(taskId)).toBeNull();
  });

  it("reuses a failed/cancelled attached run (worktree + branch persist)", async () => {
    for (const status of ["failed", "cancelled", "idle"]) {
      const taskId = await makeTask();
      const runId = await insertRun(taskId, status);
      await repo.attachRunToTask(taskId, runId);
      expect((await repo.resolveAttachedRun(taskId))?.id, status).toBe(runId);
    }
  });

  it("returns null when the attached run was deleted", async () => {
    const taskId = await makeTask();
    const runId = await insertRun(taskId, "completed");
    await repo.attachRunToTask(taskId, runId);
    await db.delete(agentSessions).where(eq(agentSessions.id, runId));
    expect(await repo.resolveAttachedRun(taskId)).toBeNull();
  });

  it("ifUnset no-ops when a usable run is already attached", async () => {
    const taskId = await makeTask();
    const first = await insertRun(taskId, "completed");
    const second = await insertRun(taskId, "idle");
    await repo.attachRunToTask(taskId, first);
    await repo.attachRunToTask(taskId, second, { ifUnset: true });
    expect((await repo.resolveAttachedRun(taskId))?.id).toBe(first);
  });

  it("ifUnset adopts the slot when the current pointer is closed (absent)", async () => {
    const taskId = await makeTask();
    const closed = await insertRun(taskId, "closed");
    const fresh = await insertRun(taskId, "idle");
    await repo.attachRunToTask(taskId, closed);
    await repo.attachRunToTask(taskId, fresh, { ifUnset: true });
    expect((await repo.resolveAttachedRun(taskId))?.id).toBe(fresh);
  });
});
