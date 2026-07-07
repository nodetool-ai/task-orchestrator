// __tests__/auto-launch.test.ts
//
// Tests for the proactive scheduler (lib/auto-launch.ts). The session-start is
// injected (a fake that inserts a real agent_runs row and returns its id) so
// nothing touches git or the network; everything else — task/dep queries, the
// `auto_launch` event tag, the concurrency count — runs against the real DB.

import { eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  AUTO_LAUNCH_EVENT,
  autoLaunchEligibleTasks,
  countActiveAutoLaunched,
  type SessionStarter,
} from "../lib/auto-launch";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

let planSeq = 0;

/** Create a task in the given state with the given assignee, in a fresh plan. */
async function makeTask(
  opts: {
    assignee?: string | null;
    state?: TaskState;
    dependencies?: string[];
  } = {}
): Promise<string> {
  const assignee = opts.assignee === undefined ? "claude" : opts.assignee;
  const state = opts.state ?? "todo";
  const plan = await repo.createPlan({ title: `AL Plan ${++planSeq}`, date: "2026-02-01" });
  const task = await repo.createTask({
    planId: plan.id,
    title: "T",
    assignee,
    dependencies: opts.dependencies,
  });
  if (state === "todo") return task.id;
  // Walk legal edges to reach the requested state.
  await repo.transitionTask(task.id, { state: "in_progress", assignee: assignee ?? "claude" });
  if (state === "in_progress") return task.id;
  if (state === "blocked" || state === "cancelled") {
    await repo.transitionTask(task.id, { state });
    return task.id;
  }
  await repo.transitionTask(task.id, { state: "testing" });
  if (state !== "testing") await repo.transitionTask(task.id, { state });
  return task.id;
}

/** A fake session-start that inserts a real, non-terminal agent_runs row for the
 *  task (so tag/count logic works) and returns its id. */
function makeStarter(): SessionStarter & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async ({ taskId }: { taskId: string }) => {
    calls.push(taskId);
    const row = (
      await db
        .insert(agentSessions)
        .values({
          taskId,
          goal: "<implement>",
          status: "running",
          cwdStrategy: "worktree",
          startedAt: new Date(),
        })
        .returning({ id: agentSessions.id })
    )[0];
    return { id: row!.id };
  }) as SessionStarter & { calls: string[] };
  fn.calls = calls;
  return fn;
}

async function autoLaunchEventCount(): Promise<number> {
  return (
    await db.select({ id: agentEvents.id }).from(agentEvents).where(eq(agentEvents.type, AUTO_LAUNCH_EVENT))
  ).length;
}

function enable(over: Record<string, string> = {}) {
  vi.stubEnv("TASK_ORCH_AUTO_LAUNCH", "1");
  vi.stubEnv("TASK_ORCH_AUTO_LAUNCH_ASSIGNEE", "claude");
  vi.stubEnv("TASK_ORCH_AUTO_LAUNCH_MAX_CONCURRENT", "3");
  for (const [k, v] of Object.entries(over)) vi.stubEnv(k, v);
}

describe("autoLaunchEligibleTasks — disabled", () => {
  it("is a no-op when the master switch is off", async () => {
    // Flag unset → disabled by default.
    const task = await makeTask();
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([]);
    expect(await autoLaunchEventCount()).toBe(0);
    // Task untouched.
    expect((await repo.getTask(task))!.state).toBe("todo");
  });

  it("is a no-op when the flag is explicitly falsey", async () => {
    vi.stubEnv("TASK_ORCH_AUTO_LAUNCH", "0");
    await makeTask();
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([]);
  });
});

describe("autoLaunchEligibleTasks — eligibility", () => {
  beforeEach(() => enable());

  it("launches an eligible todo task and tags it auto_launch", async () => {
    const task = await makeTask();
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([task]);
    expect(await autoLaunchEventCount()).toBe(1);
    expect(await countActiveAutoLaunched()).toBe(1);
  });

  it("launches a task whose dependencies are all merged", async () => {
    const dep = await makeTask({ state: "merged" });
    const task = await makeTask({ dependencies: [dep] });
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([task]);
  });

  it("skips a task with an unmet (non-merged) dependency", async () => {
    const dep = await makeTask({ state: "todo" }); // not merged
    const task = await makeTask({ dependencies: [dep] });
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    // The dependent is skipped; only the dep itself (no deps) is eligible.
    expect(start.calls).toEqual([dep]);
    expect(start.calls).not.toContain(task);
  });

  it("skips a task whose assignee does not match", async () => {
    await makeTask({ assignee: "human" });
    const mine = await makeTask({ assignee: "claude" });
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([mine]);
  });

  it("skips a task with no assignee", async () => {
    await makeTask({ assignee: null });
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([]);
  });

  it("skips a non-todo task", async () => {
    await makeTask({ state: "in_progress" });
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([]);
  });

  it("skips a task that already has an active (non-terminal) run", async () => {
    const task = await makeTask();
    await db.insert(agentSessions).values({
      taskId: task,
      goal: "<implement>",
      status: "running",
      cwdStrategy: "worktree",
      startedAt: new Date(),
    });
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([]);
  });

  it("still launches a task whose only run is terminal", async () => {
    const task = await makeTask();
    await db.insert(agentSessions).values({
      taskId: task,
      goal: "<implement>",
      status: "failed",
      cwdStrategy: "worktree",
      startedAt: new Date(),
    });
    const start = makeStarter();
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls).toEqual([task]);
  });
});

describe("autoLaunchEligibleTasks — concurrency ceiling", () => {
  it("launches at most the ceiling, then 0 on the next tick", async () => {
    enable({ TASK_ORCH_AUTO_LAUNCH_MAX_CONCURRENT: "2" });
    // Five eligible tasks.
    for (let i = 0; i < 5; i++) await makeTask();
    const start = makeStarter();

    // Tick 1: cap=2 → exactly 2 launched.
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls.length).toBe(2);
    expect(await countActiveAutoLaunched()).toBe(2);

    // Tick 2: 2 already active (ceiling reached) → 0 more.
    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls.length).toBe(2);
    expect(await countActiveAutoLaunched()).toBe(2);
  });

  it("terminal auto-launched runs free up budget on a later tick", async () => {
    enable({ TASK_ORCH_AUTO_LAUNCH_MAX_CONCURRENT: "1" });
    for (let i = 0; i < 3; i++) await makeTask();
    const start = makeStarter();

    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls.length).toBe(1);

    // Finish the first auto-launched run: its slot frees up.
    await db
      .update(agentSessions)
      .set({ status: "completed" })
      .where(eq(agentSessions.taskId, start.calls[0]!));
    expect(await countActiveAutoLaunched()).toBe(0);

    await autoLaunchEligibleTasks({ startSession: start });
    expect(start.calls.length).toBe(2);
  });
});

describe("autoLaunchEligibleTasks — best-effort", () => {
  beforeEach(() => enable());

  it("one launch throwing does not stop the others", async () => {
    const a = await makeTask();
    const b = await makeTask();
    const c = await makeTask();
    const attempted: string[] = [];
    const start: SessionStarter = async ({ taskId }) => {
      attempted.push(taskId);
      if (taskId === b) throw new Error("boom");
      const row = (
        await db
          .insert(agentSessions)
          .values({
            taskId,
            goal: "<implement>",
            status: "running",
            cwdStrategy: "worktree",
            startedAt: new Date(),
          })
          .returning({ id: agentSessions.id })
      )[0];
      return { id: row!.id };
    };
    await autoLaunchEligibleTasks({ startSession: start });
    // All three attempted; a and c launched (tagged), b threw and was skipped.
    expect(attempted).toEqual([a, b, c]);
    expect(await autoLaunchEventCount()).toBe(2);
    expect(await countActiveAutoLaunched()).toBe(2);
  });
});
