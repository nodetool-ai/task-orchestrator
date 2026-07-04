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
  it("fails a PENDING run whose depth was pushed over the cap by a direct DB write, without ever spawning", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const root = await create({ goal: "<implement>", defer: true });
    const c1 = await create({ goal: "<implement>", defer: true, parentRunId: root.id });
    const c2 = await create({ goal: "<implement>", defer: true, parentRunId: c1.id });
    const c3 = await create({ goal: "<implement>", defer: true, parentRunId: c2.id });
    // A valid, depth-1 run at create time...
    const bypass = await create({ goal: "<implement>", defer: true, parentRunId: root.id });
    // ...whose parent is repointed directly in the DB (skipping create()'s
    // check entirely) to sit past the default depth cap (would be depth 4). Set
    // status='pending' too: the re-verify only fires on a run still queued for
    // its FIRST Machine (the real pump surface — see FIX B), so a direct write
    // that also queues the row is what this defense-in-depth is meant to catch.
    await db
      .update(agentSessions)
      .set({ parentRunId: c3.id, status: "pending" })
      .where(eq(agentSessions.id, bypass.id));

    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(bypass.id, { spawn });

    expect(result).toBe("spawn-failed");
    expect(spawn).not.toHaveBeenCalled();
    const row = (await get(bypass.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/TASK_ORCH_MAX_RUN_DEPTH/);
  });

  it("does NOT tree-limit-fail a resumable run (status not 'pending') sitting over-depth", async () => {
    // A healthy run that already ran (or a terminal child taking a follow-up
    // turn) must be re-dispatchable even when its tree exceeds the cap:
    // countTreeRuns never shrinks, so a TOCTOU overshoot at create time (or rows
    // predating the feature) would otherwise permanently fail every resume. Only
    // 'pending' rows — those still queued for their first Machine — are
    // re-verified (FIX B); a non-'pending' row dispatches normally.
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const root = await create({ goal: "<implement>", defer: true });
    const c1 = await create({ goal: "<implement>", defer: true, parentRunId: root.id });
    const c2 = await create({ goal: "<implement>", defer: true, parentRunId: c1.id });
    const c3 = await create({ goal: "<implement>", defer: true, parentRunId: c2.id });
    // Depth-1 at create, then repointed over the cap (would be depth 4) — but it
    // is a resumable run (status 'idle', not 'pending'), i.e. one that already
    // reached a Machine at least once.
    const resumable = await create({ goal: "<implement>", defer: true, parentRunId: root.id });
    await db
      .update(agentSessions)
      .set({ parentRunId: c3.id, status: "idle" })
      .where(eq(agentSessions.id, resumable.id));

    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(resumable.id, { spawn });

    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    const row = (await get(resumable.id))!;
    expect(row.status).not.toBe("failed");
  });
});

describe("cyclic parent_run_id graph (direct-DB-write threat model)", () => {
  it(
    "does not hang: create() of a child of a run in a 2-cycle terminates (succeeds or rejects per limits)",
    async () => {
      // Nothing enforces acyclicity at the DB level, so a direct write could form
      // A→B→A. Both the app-level parent walk (visited-set guard) AND the
      // countTreeRuns recursive CTE (UNION, not UNION ALL — FIX D) must terminate
      // on it rather than spinning forever. The 5s test timeout is the real
      // assertion: a regression to UNION ALL would hang the CTE and blow it.
      const a = await create({ goal: "<implement>", defer: true });
      const b = await create({ goal: "<implement>", defer: true });
      await db.update(agentSessions).set({ parentRunId: b.id }).where(eq(agentSessions.id, a.id));
      await db.update(agentSessions).set({ parentRunId: a.id }).where(eq(agentSessions.id, b.id));

      let threw = false;
      try {
        const child = await create({ goal: "<implement>", defer: true, parentRunId: a.id });
        expect(child.parentRunId).toBe(a.id);
      } catch {
        threw = true; // a limit rejection is also an acceptable, terminating outcome
      }
      // Reaching here at all (no hang) is the point; either branch is valid.
      expect(typeof threw).toBe("boolean");
    },
    5000
  );
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
