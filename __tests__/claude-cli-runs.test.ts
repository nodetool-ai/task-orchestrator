import { beforeEach, describe, expect, it } from "vitest";
import { ne } from "drizzle-orm";
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
import * as runs from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";

beforeEach(() => {
  seedPersonas();
  db.delete(agentMessages).run();
  db.delete(agentEvents).run();
  db.delete(agentSessions).run();
  db.delete(acceptanceCriteria).run();
  db.delete(taskNotes).run();
  db.delete(taskDependencies).run();
  db.delete(tasks).run();
  db.delete(plans).run();
  db.delete(repositories).where(ne(repositories.id, "R-default")).run();
});

function makeTask() {
  const plan = repo.createPlan({ title: "p", body: "" });
  return repo.createTask({ planId: plan.id, title: "t", body: "" });
}

describe("runs.create with harness=claude_cli", () => {
  it("rejects chat-style runs", () => {
    expect(() => runs.create({ goal: "<chat>", harness: "claude_cli" })).toThrow(
      /claude_cli only supports implement-style/
    );
  });

  it("rejects non-worktree cwd strategies", () => {
    const task = makeTask();
    expect(() =>
      runs.create({
        goal: "<implement>",
        harness: "claude_cli",
        cwdStrategy: "repo",
        taskId: task.id,
      })
    ).toThrow(/claude_cli only supports implement-style/);
  });

  it("persists the harness and defaults to pi", () => {
    const task = makeTask();
    const cli = runs.create({
      goal: "<implement>",
      harness: "claude_cli",
      taskId: task.id,
      defer: true,
    });
    expect(cli.harness).toBe("claude_cli");
    const pi = runs.create({ goal: "<chat>", defer: true });
    expect(pi.harness).toBe("pi");
  });

  it("keeps hookToken out of RunRow", () => {
    const task = makeTask();
    const run = runs.create({
      goal: "<implement>",
      harness: "claude_cli",
      taskId: task.id,
      defer: true,
    });
    expect("hookToken" in run).toBe(false);
  });
});

describe("getHookAuth / handleClaudeHook", () => {
  it("returns harness and status for the hook route", () => {
    const task = makeTask();
    const run = runs.create({
      goal: "<implement>",
      harness: "claude_cli",
      taskId: task.id,
      defer: true,
    });
    const auth = runs.getHookAuth(run.id);
    expect(auth).not.toBeNull();
    expect(auth!.harness).toBe("claude_cli");
    expect(auth!.status).toBe("idle"); // defer → idle, no worker started
    expect(runs.getHookAuth(999999)).toBeNull();
  });

  it("SessionStart persists the transcript path even without a live handle", () => {
    const task = makeTask();
    const run = runs.create({
      goal: "<implement>",
      harness: "claude_cli",
      taskId: task.id,
      defer: true,
    });
    runs.handleClaudeHook(run.id, {
      hook_event_name: "SessionStart",
      transcript_path: "/tmp/x.jsonl",
    });
    expect(runs.get(run.id)?.transcriptPath).toBe("/tmp/x.jsonl");
  });

  it("ignores unknown hook events", () => {
    const task = makeTask();
    const run = runs.create({
      goal: "<implement>",
      harness: "claude_cli",
      taskId: task.id,
      defer: true,
    });
    expect(() =>
      runs.handleClaudeHook(run.id, { hook_event_name: "SomethingElse" })
    ).not.toThrow();
  });
});
