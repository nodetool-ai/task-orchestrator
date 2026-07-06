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
import { ORCHESTRATOR_TOOLS } from "../lib/orchestrator-tools";
import type { TaskState } from "../lib/types";

beforeEach(async () => {
  // Reverse-FK order so parent-cascade can't bite us if FKs ever get tightened.
  await db.delete(agentMessages);
  await db.delete(agentEvents);
  await db.delete(agentSessions);
  await db.delete(acceptanceCriteria);
  await db.delete(taskNotes);
  await db.delete(taskDependencies);
  await db.delete(tasks);
  await db.delete(plans);
  // Keep the seeded R-default repo; clear the rest so each test starts clean.
  await db.delete(repositories).where(ne(repositories.id, "R-default"));
});

function tool(name: string) {
  const t = ORCHESTRATOR_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not in registry`);
  return t;
}

const ctx = { author: "test" as const };

async function makeTaskInState(state: TaskState) {
  const plan = await repo.createPlan({ title: "PR Plan", date: "2026-01-15" });
  const task = await repo.createTask({ planId: plan.id, title: "T", date: "2026-01-15" });
  if (state === "todo") return task;
  const inProgress = await repo.transitionTask(task.id, { state: "in_progress", assignee: "alice" });
  if (state === "in_progress") return inProgress;
  return repo.transitionTask(task.id, { state });
}

describe("set_task_pr tool", () => {
  it("sets pr_url and advances in_progress → testing", async () => {
    const task = await makeTaskInState("in_progress");
    const res = await tool("set_task_pr").execute(
      { task_id: task.id, pr_url: "https://github.com/o/r/pull/5" },
      ctx
    );
    expect(res.isError).toBeFalsy();
    const updated = await repo.getTask(task.id);
    expect(updated!.prUrl).toBe("https://github.com/o/r/pull/5");
    expect(updated!.state).toBe("testing");
  });

  it("records pr_url on a todo task without crashing or forcing a state it hasn't earned", async () => {
    // todo can't jump straight to testing (TASK_TRANSITIONS requires
    // todo → in_progress first); set_task_pr must not throw here, and must
    // leave the task at todo rather than fake a transition.
    const task = await makeTaskInState("todo");
    const res = await tool("set_task_pr").execute(
      { task_id: task.id, pr_url: "https://github.com/o/r/pull/1" },
      ctx
    );
    expect(res.isError).toBeFalsy();
    const updated = await repo.getTask(task.id);
    expect(updated!.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(updated!.state).toBe("todo");
  });

  it("rejects a malformed pr_url without changing state or pr_url", async () => {
    const task = await makeTaskInState("in_progress");
    const res = await tool("set_task_pr").execute(
      { task_id: task.id, pr_url: "not-a-url" },
      ctx
    );
    expect(res.isError).toBe(true);
    const unchanged = await repo.getTask(task.id);
    expect(unchanged!.prUrl).toBeNull();
    expect(unchanged!.state).toBe("in_progress");
  });

  it("is idempotent when the task is already testing — updates pr_url, no re-transition", async () => {
    const task = await makeTaskInState("testing");
    const first = await tool("set_task_pr").execute(
      { task_id: task.id, pr_url: "https://github.com/o/r/pull/1" },
      ctx
    );
    expect(first.isError).toBeFalsy();
    const second = await tool("set_task_pr").execute(
      { task_id: task.id, pr_url: "https://github.com/o/r/pull/2" },
      ctx
    );
    expect(second.isError).toBeFalsy();
    const updated = await repo.getTask(task.id);
    expect(updated!.prUrl).toBe("https://github.com/o/r/pull/2");
    expect(updated!.state).toBe("testing");
  });

  it("does not force a backward transition when the task is blocked", async () => {
    const task = await makeTaskInState("blocked");
    const res = await tool("set_task_pr").execute(
      { task_id: task.id, pr_url: "https://github.com/o/r/pull/9" },
      ctx
    );
    expect(res.isError).toBeFalsy();
    const updated = await repo.getTask(task.id);
    expect(updated!.prUrl).toBe("https://github.com/o/r/pull/9");
    expect(updated!.state).toBe("blocked");
  });

  it("normalizes a short-form owner/repo#n url to canonical before storing", async () => {
    const task = await makeTaskInState("in_progress");
    const res = await tool("set_task_pr").execute(
      { task_id: task.id, pr_url: "acme/widgets#42" },
      ctx
    );
    expect(res.isError).toBeFalsy();
    const updated = await repo.getTask(task.id);
    expect(updated!.prUrl).toBe("https://github.com/acme/widgets/pull/42");
  });
});
