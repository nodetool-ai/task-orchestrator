import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentSessions, plans, tasks } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import * as chat from "../lib/chat";
import { isImplementWorktree, worktreeBranchName } from "../lib/runs";

// Chat sessions are lightweight by default: no git worktree, no branch, no PR.
// Callers that need filesystem isolation can still request a taskless worktree:
// a `claude/chat-<id>` branch, no auto-push, no PR, and an `idle`/resumable
// lifecycle.

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
});

describe("createChat cwd strategy", () => {
  it("defaults to 'none' so ordinary chats stay lightweight", async () => {
    const c = await chat.createChat(null, "New chat", null);
    expect(c.cwdStrategy).toBe("none");
    expect(c.backend).toBe("pi");
  });

  it("honors an explicit override", async () => {
    const c = await chat.createChat(null, "scratch", null, "worktree");
    expect(c.cwdStrategy).toBe("worktree");
  });
});

describe("worktreeBranchName", () => {
  it("uses the task's canonical branch (no run suffix) so every run shares it", () => {
    expect(worktreeBranchName({ id: 7, taskId: "T-20260628-0001" })).toBe(
      "claude/t-20260628-0001"
    );
    // Deterministic across runs: a later run on the same task computes the
    // same branch.
    expect(worktreeBranchName({ id: 99, taskId: "T-20260628-0001" })).toBe(
      "claude/t-20260628-0001"
    );
  });

  it("falls back to a chat-scoped per-run name when there is no task", () => {
    expect(worktreeBranchName({ id: 42, taskId: null })).toBe("claude/chat-42");
  });
});

describe("isImplementWorktree", () => {
  it("is true for a worktree run with an implement goal (push/PR lifecycle)", () => {
    expect(isImplementWorktree({ cwdStrategy: "worktree", goal: "<implement>" })).toBe(true);
  });

  it("is false for a chat-goal worktree (isolation only, no push/PR)", () => {
    expect(isImplementWorktree({ cwdStrategy: "worktree", goal: "<chat>" })).toBe(false);
  });

  it("is false for non-worktree strategies", () => {
    expect(isImplementWorktree({ cwdStrategy: "none", goal: "<chat>" })).toBe(false);
    expect(isImplementWorktree({ cwdStrategy: "repo", goal: "<execute>" })).toBe(false);
  });
});
