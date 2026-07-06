// __tests__/pr-task-state-sync.test.ts
//
// Tests for the GitHub PR + CI → task-state sync (lib/pr-task-state.ts):
//   • prToTaskState: the pure mapper, every branch.
//   • rollupToCiConclusion: statusCheckRollup → ciConclusion.
//   • applyTaskStateFromPr / syncPrBackedTasks: DB-backed, with the gh fetch
//     mocked (an injected fake fetcher) so no subprocess/network is touched.

import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import {
  acceptanceCriteria,
  agentEvents,
  agentMessages,
  agentSessions,
  plans,
  repositories,
  taskDependencies,
  taskNotes,
  tasks,
} from "../db/schema";
import * as repo from "../lib/repo";
import {
  applyTaskStateFromPr,
  prToTaskState,
  rollupToCiConclusion,
  syncPrBackedTasks,
  type PrGithubState,
} from "../lib/pr-task-state";
import type { TaskState } from "../lib/types";

beforeEach(async () => {
  await db.delete(agentMessages);
  await db.delete(agentEvents);
  await db.delete(agentSessions);
  await db.delete(acceptanceCriteria);
  await db.delete(taskNotes);
  await db.delete(taskDependencies);
  await db.delete(tasks);
  await db.delete(plans);
  await db.delete(repositories).where(ne(repositories.id, "R-default"));
});

// ──────────────────────────────────────────────────────────
// Pure mapper
// ──────────────────────────────────────────────────────────

const gh = (over: Partial<PrGithubState> = {}): PrGithubState => ({
  merged: false,
  closed: false,
  ciConclusion: "none",
  ...over,
});

describe("prToTaskState", () => {
  it("merged → merged", () => {
    expect(prToTaskState(gh({ merged: true }))).toBe("merged");
  });
  it("merged wins even if closed/failure also set", () => {
    expect(prToTaskState(gh({ merged: true, closed: true, ciConclusion: "failure" }))).toBe(
      "merged"
    );
  });
  it("closed (unmerged) → blocked", () => {
    expect(prToTaskState(gh({ closed: true }))).toBe("blocked");
  });
  it("CI failure → failing", () => {
    expect(prToTaskState(gh({ ciConclusion: "failure" }))).toBe("failing");
  });
  it("CI success → passing", () => {
    expect(prToTaskState(gh({ ciConclusion: "success" }))).toBe("passing");
  });
  it("CI pending → testing", () => {
    expect(prToTaskState(gh({ ciConclusion: "pending" }))).toBe("testing");
  });
  it("CI none → testing", () => {
    expect(prToTaskState(gh({ ciConclusion: "none" }))).toBe("testing");
  });
});

describe("rollupToCiConclusion", () => {
  it("empty rollup → none", () => {
    expect(rollupToCiConclusion([])).toBe("none");
  });
  it("all completed success → success", () => {
    expect(
      rollupToCiConclusion([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "completed", conclusion: "success" },
      ])
    ).toBe("success");
  });
  it("success + neutral/skipped → success", () => {
    expect(
      rollupToCiConclusion([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "neutral" },
        { status: "completed", conclusion: "skipped" },
      ])
    ).toBe("success");
  });
  it("any failure → failure (beats pending)", () => {
    expect(
      rollupToCiConclusion([
        { status: "in_progress" },
        { status: "completed", conclusion: "failure" },
        { status: "completed", conclusion: "success" },
      ])
    ).toBe("failure");
  });
  it("timed_out / cancelled → failure", () => {
    expect(rollupToCiConclusion([{ status: "completed", conclusion: "timed_out" }])).toBe(
      "failure"
    );
    expect(rollupToCiConclusion([{ status: "completed", conclusion: "cancelled" }])).toBe(
      "failure"
    );
  });
  it("in-flight check → pending", () => {
    expect(
      rollupToCiConclusion([
        { status: "in_progress" },
        { status: "completed", conclusion: "success" },
      ])
    ).toBe("pending");
  });
  it("legacy commit-status state → mapped", () => {
    expect(rollupToCiConclusion([{ state: "SUCCESS" }])).toBe("success");
    expect(rollupToCiConclusion([{ state: "FAILURE" }])).toBe("failure");
    expect(rollupToCiConclusion([{ state: "PENDING" }])).toBe("pending");
  });
});

// ──────────────────────────────────────────────────────────
// DB-backed apply / sync
// ──────────────────────────────────────────────────────────

let planSeq = 0;

async function makeTaskInState(state: TaskState, prUrl?: string) {
  // Unique plan title per call: createPlan derives a deterministic id from the
  // title, so a shared title would collide across tasks in the same test.
  const plan = await repo.createPlan({ title: `Sync Plan ${++planSeq}`, date: "2026-01-15" });
  const task = await repo.createTask({ planId: plan.id, title: "T" });
  if (prUrl) await repo.setTaskPr(task.id, prUrl);
  if (state === "todo") return (await repo.getTask(task.id))!;
  await repo.transitionTask(task.id, { state: "in_progress", assignee: "alice" });
  if (state === "in_progress") return (await repo.getTask(task.id))!;
  // Walk legal edges: in_progress → testing → {passing,failing,merged}; and
  // in_progress → {blocked,cancelled} directly.
  if (state === "blocked" || state === "cancelled") {
    await repo.transitionTask(task.id, { state });
    return (await repo.getTask(task.id))!;
  }
  await repo.transitionTask(task.id, { state: "testing" });
  if (state !== "testing") await repo.transitionTask(task.id, { state });
  return (await repo.getTask(task.id))!;
}

/** A fetcher that always returns the given state, ignoring the URL. */
const fixedFetcher = (s: PrGithubState) => async () => s;

describe("applyTaskStateFromPr", () => {
  it("testing → passing on CI success", async () => {
    const task = await makeTaskInState("testing", "https://github.com/o/r/pull/1");
    await applyTaskStateFromPr(task, gh({ ciConclusion: "success" }));
    expect((await repo.getTask(task.id))!.state).toBe("passing");
  });

  it("testing → failing on CI failure", async () => {
    const task = await makeTaskInState("testing", "https://github.com/o/r/pull/2");
    await applyTaskStateFromPr(task, gh({ ciConclusion: "failure" }));
    expect((await repo.getTask(task.id))!.state).toBe("failing");
  });

  it("testing → merged on merge (bypasses open acceptance criteria)", async () => {
    const task = await makeTaskInState("testing", "https://github.com/o/r/pull/3");
    await repo.addCriterion(task.id, "not done yet");
    await applyTaskStateFromPr(task, gh({ merged: true }));
    expect((await repo.getTask(task.id))!.state).toBe("merged");
  });

  it("no-op when target equals current state", async () => {
    const task = await makeTaskInState("testing", "https://github.com/o/r/pull/4");
    // pending → testing, which is the current state: nothing changes, no throw.
    await applyTaskStateFromPr(task, gh({ ciConclusion: "pending" }));
    expect((await repo.getTask(task.id))!.state).toBe("testing");
  });

  it("no-op (no throw) on an illegal transition", async () => {
    // A merged task is terminal; nothing can move it. A green PR would map to
    // "passing", an illegal edge from "merged" → must silently no-op.
    const task = await makeTaskInState("merged", "https://github.com/o/r/pull/5");
    await expect(
      applyTaskStateFromPr(task, gh({ ciConclusion: "success" }))
    ).resolves.toBeUndefined();
    expect((await repo.getTask(task.id))!.state).toBe("merged");
  });
});

describe("syncPrBackedTasks", () => {
  it("drives a testing task to passing on a green PR (fetch mocked)", async () => {
    const task = await makeTaskInState("testing", "https://github.com/o/r/pull/10");
    await syncPrBackedTasks(fixedFetcher(gh({ ciConclusion: "success" })));
    expect((await repo.getTask(task.id))!.state).toBe("passing");
  });

  it("drives a testing task to failing on a red PR", async () => {
    const task = await makeTaskInState("testing", "https://github.com/o/r/pull/11");
    await syncPrBackedTasks(fixedFetcher(gh({ ciConclusion: "failure" })));
    expect((await repo.getTask(task.id))!.state).toBe("failing");
  });

  it("drives a testing task to merged on a merged PR", async () => {
    const task = await makeTaskInState("testing", "https://github.com/o/r/pull/12");
    await syncPrBackedTasks(fixedFetcher(gh({ merged: true })));
    expect((await repo.getTask(task.id))!.state).toBe("merged");
  });

  it("skips terminal (merged/cancelled) tasks — never fetched", async () => {
    const merged = await makeTaskInState("merged", "https://github.com/o/r/pull/13");
    const cancelled = await makeTaskInState("cancelled", "https://github.com/o/r/pull/14");
    const fetched: string[] = [];
    await syncPrBackedTasks(async (url) => {
      fetched.push(url);
      return gh({ ciConclusion: "success" });
    });
    expect(fetched).toEqual([]);
    expect((await repo.getTask(merged.id))!.state).toBe("merged");
    expect((await repo.getTask(cancelled.id))!.state).toBe("cancelled");
  });

  it("skips tasks with no pr_url", async () => {
    const task = await makeTaskInState("testing"); // no PR url
    const fetched: string[] = [];
    await syncPrBackedTasks(async (url) => {
      fetched.push(url);
      return gh({ ciConclusion: "success" });
    });
    expect(fetched).toEqual([]);
    expect((await repo.getTask(task.id))!.state).toBe("testing");
  });

  it("is best-effort: one failing fetch does not abort the loop", async () => {
    const bad = await makeTaskInState("testing", "https://github.com/o/r/pull/20");
    const good = await makeTaskInState("testing", "https://github.com/o/r/pull/21");
    await syncPrBackedTasks(async (url) => {
      if (url.endsWith("/20")) throw new Error("boom");
      return gh({ ciConclusion: "success" });
    });
    // The thrown fetch left `bad` untouched; `good` still advanced.
    expect((await repo.getTask(bad.id))!.state).toBe("testing");
    expect((await repo.getTask(good.id))!.state).toBe("passing");
  });

  it("skips a task whose fetch returns null", async () => {
    const task = await makeTaskInState("testing", "https://github.com/o/r/pull/30");
    await syncPrBackedTasks(async () => null);
    expect((await repo.getTask(task.id))!.state).toBe("testing");
  });
});
