import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentSessions, plans, tasks } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import * as chat from "../lib/chat";
import { isImplementWorktree, worktreeBranchName } from "../lib/runs";

// Every chat session runs in its own git worktree (filesystem isolation) instead
// of the shared repo checkout. Chat runs have no task, so the worktree machinery
// must work taskless: a `claude/chat-<id>` branch, no auto-push, no PR, and an
// `idle`/resumable lifecycle.

beforeEach(() => {
  seedPersonas();
  db.delete(agentSessions).run();
  db.delete(tasks).run();
  db.delete(plans).run();
});

describe("createChat cwd strategy", () => {
  it("defaults to 'worktree' so every chat (web + Discord) is isolated", () => {
    const c = chat.createChat(null, "New chat", null);
    expect(c.cwdStrategy).toBe("worktree");
  });

  it("honors an explicit override", () => {
    const c = chat.createChat(null, "scratch", null, "none");
    expect(c.cwdStrategy).toBe("none");
  });
});

describe("worktreeBranchName", () => {
  it("uses the task id for implement-style runs", () => {
    expect(worktreeBranchName({ id: 7, taskId: "T-20260628-0001" })).toBe(
      "claude/t-20260628-0001-7"
    );
  });

  it("falls back to a chat-scoped name when there is no task", () => {
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
