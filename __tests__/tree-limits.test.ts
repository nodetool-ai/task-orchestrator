// __tests__/tree-limits.test.ts
// Tree limits (docs/nested-machine-dispatch.md, Decision 2 — "Tree limits (new,
// enforced at creation)"): TASK_ORCH_MAX_RUN_DEPTH and TASK_ORCH_MAX_TREE_RUNS
// bound how deep and how large a parent_run_id tree can grow before a worker
// fans out to real, billable compute. create() rejects synchronously; dispatchRun
// re-verifies server-side as defense in depth against a worker that writes rows
// directly (bypassing create()'s check).
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";

const KNOBS = ["TASK_ORCH_MAX_RUN_DEPTH", "TASK_ORCH_MAX_TREE_RUNS", "TASK_ORCH_WORKER_IMAGE"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
});

describe("run tree depth limit (TASK_ORCH_MAX_RUN_DEPTH)", () => {
  it("default (3): allows root -> c1 -> c2 -> c3, rejects a child of c3", async () => {
    const root = await create({ goal: "<implement>", defer: true });
    const c1 = await create({ goal: "<implement>", defer: true, parentRunId: root.id });
    const c2 = await create({ goal: "<implement>", defer: true, parentRunId: c1.id });
    const c3 = await create({ goal: "<implement>", defer: true, parentRunId: c2.id });

    await expect(
      create({ goal: "<implement>", defer: true, parentRunId: c3.id })
    ).rejects.toThrow(/TASK_ORCH_MAX_RUN_DEPTH/);
  });

  it("TASK_ORCH_MAX_RUN_DEPTH=1: direct child allowed, grandchild rejected", async () => {
    process.env.TASK_ORCH_MAX_RUN_DEPTH = "1";
    const root = await create({ goal: "<implement>", defer: true });
    const c1 = await create({ goal: "<implement>", defer: true, parentRunId: root.id });

    await expect(
      create({ goal: "<implement>", defer: true, parentRunId: c1.id })
    ).rejects.toThrow(/TASK_ORCH_MAX_RUN_DEPTH/);
  });

  it("TASK_ORCH_MAX_RUN_DEPTH=0 disables the check (a deep chain is allowed)", async () => {
    process.env.TASK_ORCH_MAX_RUN_DEPTH = "0";
    let parentId: number | null = null;
    for (let i = 0; i < 8; i++) {
      const run = await create({ goal: "<implement>", defer: true, parentRunId: parentId });
      parentId = run.id;
    }
    // Reaching here without a throw is the assertion; also sanity-check the tail.
    const last = await get(parentId!);
    expect(last?.parentRunId).not.toBeNull();
  });
});

describe("run tree size limit (TASK_ORCH_MAX_TREE_RUNS)", () => {
  it("TASK_ORCH_MAX_TREE_RUNS=3: third run in the tree is allowed, fourth is rejected", async () => {
    process.env.TASK_ORCH_MAX_TREE_RUNS = "3";
    const root = await create({ goal: "<implement>", defer: true }); // 1
    const c1 = await create({ goal: "<implement>", defer: true, parentRunId: root.id }); // 2
    const c2 = await create({ goal: "<implement>", defer: true, parentRunId: root.id }); // 3
    void c1;
    void c2;

    await expect(
      create({ goal: "<implement>", defer: true, parentRunId: root.id })
    ).rejects.toThrow(/TASK_ORCH_MAX_TREE_RUNS/);
  });

  it("does not count runs belonging to a different tree", async () => {
    process.env.TASK_ORCH_MAX_TREE_RUNS = "3";
    const rootA = await create({ goal: "<implement>", defer: true });
    await create({ goal: "<implement>", defer: true, parentRunId: rootA.id });
    await create({ goal: "<implement>", defer: true, parentRunId: rootA.id });
    // Tree A is now full (3 runs). Tree B is independent and unaffected.
    const rootB = await create({ goal: "<implement>", defer: true });
    const childB = await create({ goal: "<implement>", defer: true, parentRunId: rootB.id });
    expect(childB.parentRunId).toBe(rootB.id);
  });
});

describe("dispatchRun re-verifies tree limits (defense in depth)", () => {
  it("fails a run whose depth was pushed over the cap by a direct DB write, without ever spawning", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const root = await create({ goal: "<implement>", defer: true });
    const c1 = await create({ goal: "<implement>", defer: true, parentRunId: root.id });
    const c2 = await create({ goal: "<implement>", defer: true, parentRunId: c1.id });
    const c3 = await create({ goal: "<implement>", defer: true, parentRunId: c2.id });
    // A valid, depth-1 run at create time...
    const bypass = await create({ goal: "<implement>", defer: true, parentRunId: root.id });
    // ...whose parent is repointed directly in the DB (skipping create()'s
    // check entirely) to sit past the default depth cap (would be depth 4).
    await db
      .update(agentSessions)
      .set({ parentRunId: c3.id })
      .where(eq(agentSessions.id, bypass.id));

    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(bypass.id, { spawn });

    expect(result).toBe("spawn-failed");
    expect(spawn).not.toHaveBeenCalled();
    const row = (await get(bypass.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/TASK_ORCH_MAX_RUN_DEPTH/);
  });
});

describe("dangling parentRunId", () => {
  it("is robust to a deleted parent row: creating a child of the orphan neither throws nor loops", async () => {
    const root = await create({ goal: "<implement>", defer: true });
    const child = await create({ goal: "<implement>", defer: true, parentRunId: root.id });
    await db.delete(agentSessions).where(eq(agentSessions.id, root.id));

    const grandchild = await create({
      goal: "<implement>",
      defer: true,
      parentRunId: child.id,
    });
    expect(grandchild.parentRunId).toBe(child.id);
  });
});
