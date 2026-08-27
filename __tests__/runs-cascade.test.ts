// __tests__/runs-cascade.test.ts
//
// FIX 1 (M4): cancel(id) and close(id) only affected the target run. A
// plan-executor run spawns child runs (rows with parent_run_id = executor id,
// possibly one level deeper); cancelling/closing the executor left every in-flight
// child running, spending, and pushing. cancel()/close() now cascade to every
// non-terminal descendant (recursive on parent_run_id, visited-set + depth bound),
// cancelling each — children of a closed parent are CANCELLED, not closed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get, cancel, close } from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";
import * as dispatch from "../lib/run-dispatch";

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A disposable worker child: no worktree/git, non-terminal (running) with a fresh
// heartbeat so it reads as genuinely in-flight.
async function makeActiveChild(parentRunId: number) {
  const child = await create({ goal: "adhoc-worker", cwdStrategy: "none", parentRunId, defer: true });
  await db
    .update(agentSessions)
    .set({ status: "running"})
    .where(eq(agentSessions.id, child.id));
  return child.id;
}

describe("cancel() cascades to descendants (FIX 1)", () => {
  it("reaches a grandchild", async () => {
    vi.spyOn(dispatch, "stopRunner").mockResolvedValue(undefined as any);
    // executor (idle) → child (running) → grandchild (running)
    const parent = await create({ goal: "adhoc-parent", cwdStrategy: "none", defer: true });
    const childId = await makeActiveChild(parent.id);
    const grandchildId = await makeActiveChild(childId);

    await cancel(parent.id);

    expect((await get(parent.id))?.status).toBe("cancelled");
    expect((await get(childId))?.status).toBe("cancelled");
    expect((await get(grandchildId))?.status).toBe("cancelled");
  });

  it("leaves an already-terminal descendant untouched (no resurrection)", async () => {
    vi.spyOn(dispatch, "stopRunner").mockResolvedValue(undefined as any);
    const parent = await create({ goal: "adhoc-parent", cwdStrategy: "none", defer: true });
    const doneChild = await create({
      goal: "adhoc-worker",
      cwdStrategy: "none",
      parentRunId: parent.id,
      defer: true,
    });
    await db
      .update(agentSessions)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(agentSessions.id, doneChild.id));

    await cancel(parent.id);

    // The terminal child keeps its completed status, not flipped to cancelled.
    expect((await get(doneChild.id))?.status).toBe("completed");
  });
});

describe("close() cascades to descendants as cancels (FIX 1)", () => {
  it("cancels children of a closed parent", async () => {
    vi.spyOn(dispatch, "stopRunner").mockResolvedValue(undefined as any);
    const parent = await create({ goal: "adhoc-parent", cwdStrategy: "none", defer: true });
    const childId = await makeActiveChild(parent.id);
    const grandchildId = await makeActiveChild(childId);

    const after = await close(parent.id);

    expect(after.status).toBe("closed");
    // Children are cancelled (workers for the closed parent), not closed.
    expect((await get(childId))?.status).toBe("cancelled");
    expect((await get(grandchildId))?.status).toBe("cancelled");
  });
});
