import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, plans, tasks } from "../db/schema";
import * as repo from "../lib/repo";
import { seedPersonas } from "../db/seed-personas";

// resolveAttachedRun / attachRunToTask back the one-run-per-task model: a
// pointer on tasks.attached_run_id, with `closed` runs treated as absent.

beforeEach(() => {
  seedPersonas();
  db.delete(agentSessions).run();
  db.delete(tasks).run();
  db.delete(plans).run();
});

let seq = 0;
function makeTask(): string {
  const plan = repo.createPlan({ title: `Plan ${++seq}`, date: "2026-06-19" });
  return repo.createTask({ planId: plan.id, title: `Task ${seq}`, date: "2026-06-19" }).id;
}

function insertRun(taskId: string, status: string): number {
  const row = db
    .insert(agentSessions)
    .values({ goal: "<implement>", cwdStrategy: "worktree", taskId, status, personaId: "implementor" })
    .returning()
    .all();
  return row[0].id;
}

describe("resolveAttachedRun / attachRunToTask", () => {
  it("returns null when no run is attached", () => {
    const taskId = makeTask();
    expect(repo.resolveAttachedRun(taskId)).toBeNull();
  });

  it("resolves the attached run after attaching", () => {
    const taskId = makeTask();
    const runId = insertRun(taskId, "completed");
    repo.attachRunToTask(taskId, runId);
    expect(repo.resolveAttachedRun(taskId)?.id).toBe(runId);
  });

  it("treats a closed attached run as absent", () => {
    const taskId = makeTask();
    const runId = insertRun(taskId, "closed");
    repo.attachRunToTask(taskId, runId);
    expect(repo.resolveAttachedRun(taskId)).toBeNull();
  });

  it("reuses a failed/cancelled attached run (worktree + branch persist)", () => {
    for (const status of ["failed", "cancelled", "idle"]) {
      const taskId = makeTask();
      const runId = insertRun(taskId, status);
      repo.attachRunToTask(taskId, runId);
      expect(repo.resolveAttachedRun(taskId)?.id, status).toBe(runId);
    }
  });

  it("returns null when the attached run was deleted", () => {
    const taskId = makeTask();
    const runId = insertRun(taskId, "completed");
    repo.attachRunToTask(taskId, runId);
    db.delete(agentSessions).where(eq(agentSessions.id, runId)).run();
    expect(repo.resolveAttachedRun(taskId)).toBeNull();
  });

  it("ifUnset no-ops when a usable run is already attached", () => {
    const taskId = makeTask();
    const first = insertRun(taskId, "completed");
    const second = insertRun(taskId, "idle");
    repo.attachRunToTask(taskId, first);
    repo.attachRunToTask(taskId, second, { ifUnset: true });
    expect(repo.resolveAttachedRun(taskId)?.id).toBe(first);
  });

  it("ifUnset adopts the slot when the current pointer is closed (absent)", () => {
    const taskId = makeTask();
    const closed = insertRun(taskId, "closed");
    const fresh = insertRun(taskId, "idle");
    repo.attachRunToTask(taskId, closed);
    repo.attachRunToTask(taskId, fresh, { ifUnset: true });
    expect(repo.resolveAttachedRun(taskId)?.id).toBe(fresh);
  });
});
