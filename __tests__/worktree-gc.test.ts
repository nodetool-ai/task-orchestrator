import { ne } from "drizzle-orm";
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
import {
  type GcCandidate,
  runWorktreeGcOnce,
  shouldRemoveWorktree,
} from "../lib/worktree-gc";

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
  vi.restoreAllMocks();
});

const NOW = new Date("2026-05-13T12:00:00Z");
const TEN_DAYS_AGO = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);

function makeCandidate(over: Partial<GcCandidate> = {}): GcCandidate {
  return {
    runId: 1,
    status: "idle",
    branch: "claude/t-100-1",
    worktreePath: "/tmp/repo/.worktrees/1",
    repoId: "R-default",
    baseBranch: "main",
    lastActivityAt: TEN_DAYS_AGO,
    ...over,
  };
}

describe("shouldRemoveWorktree predicate", () => {
  it("removes when idle >= threshold AND branch has 0 commits ahead AND tree is clean", async () => {
    const decision = await shouldRemoveWorktree({
      candidate: makeCandidate(),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
    });
    expect(decision.remove).toBe(true);
    if (decision.remove) {
      expect(decision.idleDays).toBeCloseTo(10, 1);
    }
  });

  it("keeps a DIRTY worktree even when idle and 0 commits ahead (never destroy uncommitted work)", async () => {
    const decision = await shouldRemoveWorktree({
      candidate: makeCandidate(),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => true,
    });
    expect(decision.remove).toBe(false);
    if (!decision.remove) {
      expect(decision.reason).toMatch(/dirty/i);
    }
  });

  it("keeps (fail closed) when the dirty check errors", async () => {
    const decision = await shouldRemoveWorktree({
      candidate: makeCandidate(),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => {
        throw new Error("git status blew up");
      },
    });
    expect(decision.remove).toBe(false);
    if (!decision.remove) {
      expect(decision.reason).toMatch(/status failed/i);
    }
  });

  it("keeps when branch has commits ahead of base (unmerged)", async () => {
    const decision = await shouldRemoveWorktree({
      candidate: makeCandidate(),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => true,
      revListCount: async () => 3,
      isWorktreeDirty: async () => false,
    });
    expect(decision.remove).toBe(false);
    if (!decision.remove) {
      expect(decision.reason).toMatch(/3 commits ahead/);
    }
  });

  it("keeps when run is too fresh (idle < threshold)", async () => {
    const decision = await shouldRemoveWorktree({
      candidate: makeCandidate({ lastActivityAt: TWO_DAYS_AGO }),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
    });
    expect(decision.remove).toBe(false);
    if (!decision.remove) {
      expect(decision.reason).toMatch(/idle 2/);
    }
  });

  it("keeps non-idle statuses", async () => {
    for (const status of ["running", "pending", "preparing", "completed", "closed", "failed"]) {
      const decision = await shouldRemoveWorktree({
        candidate: makeCandidate({ status }),
        now: NOW,
        thresholdDays: 7,
        worktreeExists: () => true,
        revListCount: async () => 0,
        isWorktreeDirty: async () => false,
      });
      expect(decision.remove, `status=${status}`).toBe(false);
    }
  });

  it("keeps rows with no worktree_path or branch", async () => {
    const noPath = await shouldRemoveWorktree({
      candidate: makeCandidate({ worktreePath: null }),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
    });
    expect(noPath.remove).toBe(false);

    const noBranch = await shouldRemoveWorktree({
      candidate: makeCandidate({ branch: null }),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
    });
    expect(noBranch.remove).toBe(false);
  });

  it("skips when worktree directory is already gone", async () => {
    const decision = await shouldRemoveWorktree({
      candidate: makeCandidate(),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => false,
      revListCount: async () => {
        throw new Error("should not be called");
      },
      isWorktreeDirty: async () => {
        throw new Error("should not be called");
      },
    });
    expect(decision.remove).toBe(false);
    if (!decision.remove) {
      expect(decision.reason).toMatch(/missing/);
    }
  });

  it("keeps when rev-list errors (fail closed)", async () => {
    const decision = await shouldRemoveWorktree({
      candidate: makeCandidate(),
      now: NOW,
      thresholdDays: 7,
      worktreeExists: () => true,
      revListCount: async () => {
        throw new Error("origin/main does not exist");
      },
      isWorktreeDirty: async () => false,
    });
    expect(decision.remove).toBe(false);
    if (!decision.remove) {
      expect(decision.reason).toMatch(/rev-list failed/);
    }
  });

  it("honors a custom threshold (e.g. 14 days)", async () => {
    const decision = await shouldRemoveWorktree({
      candidate: makeCandidate({ lastActivityAt: TEN_DAYS_AGO }),
      now: NOW,
      thresholdDays: 14,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
    });
    expect(decision.remove).toBe(false);
  });
});

describe("runWorktreeGcOnce", () => {
  it("removes eligible worktrees, prunes admin, and appends a system message", async () => {
    // Insert an idle run with a worktree.
    await db.insert(agentSessions)
      .values({
        id: 42,
        taskId: null,
        status: "idle",
        goal: "<implement>",
        toolsProfile: "orchestrator,repo_write",
        cwdStrategy: "worktree",
        branch: "claude/t-100-42",
        worktreePath: "/tmp/repo/.worktrees/42",
        repoId: "R-default",
        startedAt: TEN_DAYS_AGO,
      });

    const removeWorktree = vi.fn(async () => {});
    const pruneAdmin = vi.fn(async () => {});

    const result = await runWorktreeGcOnce({
      thresholdDays: 7,
      now: () => NOW,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
      removeWorktree,
      pruneAdmin,
      resolveRepoRoot: () => "/tmp/repo",
      keepWorktrees: false,
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.errors).toBe(0);
    expect(removeWorktree).toHaveBeenCalledWith("/tmp/repo/.worktrees/42", "/tmp/repo");
    expect(pruneAdmin).toHaveBeenCalledWith("/tmp/repo");

    // System message should have been appended to agent_messages.
    const msgs = await db.select().from(agentMessages);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.runId).toBe(42);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toMatch(/garbage-collected after/);
    expect(msgs[0]?.content).toMatch(/days idle/);
  });

  it("does NOT remove a dirty worktree (would destroy uncommitted work)", async () => {
    await db.insert(agentSessions)
      .values({
        id: 43,
        taskId: null,
        status: "idle",
        goal: "<chat>",
        toolsProfile: "orchestrator,repo_write",
        cwdStrategy: "worktree",
        branch: "claude/t-100-43",
        worktreePath: "/tmp/repo/.worktrees/43",
        repoId: "R-default",
        startedAt: TEN_DAYS_AGO,
      });

    const removeWorktree = vi.fn(async () => {});
    const pruneAdmin = vi.fn(async () => {});

    const result = await runWorktreeGcOnce({
      thresholdDays: 7,
      now: () => NOW,
      worktreeExists: () => true,
      revListCount: async () => 0, // 0 commits ahead — would have passed the old predicate
      isWorktreeDirty: async () => true, // …but there are uncommitted changes
      removeWorktree,
      pruneAdmin,
      resolveRepoRoot: () => "/tmp/repo",
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(pruneAdmin).not.toHaveBeenCalled();
    // No system message either — the run was left completely untouched.
    const msgs = await db.select().from(agentMessages);
    expect(msgs).toHaveLength(0);
  });

  it("skips removal and logs a preview (no DB write) when KEEP_WORKTREES is set", async () => {
    await db.insert(agentSessions)
      .values({
        id: 7,
        taskId: null,
        status: "idle",
        goal: "<implement>",
        toolsProfile: "orchestrator,repo_write",
        cwdStrategy: "worktree",
        branch: "claude/t-100-7",
        worktreePath: "/tmp/repo/.worktrees/7",
        repoId: "R-default",
        startedAt: TEN_DAYS_AGO,
      });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const removeWorktree = vi.fn(async () => {});
    const result = await runWorktreeGcOnce({
      thresholdDays: 7,
      now: () => NOW,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
      removeWorktree,
      keepWorktrees: true,
      resolveRepoRoot: () => "/tmp/repo",
    });

    expect(result.removed).toBe(0);
    expect(removeWorktree).not.toHaveBeenCalled();
    // Previously this asserted a 'system' agent_messages row was written. That
    // WAS the bug (finding #6): the note's created_at became the run's newest
    // message, and defaultListCandidates derives lastActivityAt from
    // max(agent_messages.created_at) — so writing it reset the idle clock GC
    // measures. Keep mode must NOT touch the DB; it logs to the console instead.
    const msgs = await db.select().from(agentMessages);
    expect(msgs).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/would remove worktree for run #7/));
  });

  it("keep-mode preview stays stable across repeated sweeps (no idle-clock drift)", async () => {
    // Uses the REAL defaultListCandidates (no listCandidates override) so the
    // lastActivityAt is derived from the DB exactly as in production. The run
    // has no messages, so its idle clock is anchored on startedAt.
    await db.insert(agentSessions)
      .values({
        id: 71,
        taskId: null,
        status: "idle",
        goal: "<chat>",
        toolsProfile: "orchestrator,repo_write",
        cwdStrategy: "worktree",
        branch: "claude/t-100-71",
        worktreePath: "/tmp/repo/.worktrees/71",
        repoId: "R-default",
        startedAt: TEN_DAYS_AGO,
      });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previews: string[] = [];

    async function sweep() {
      logSpy.mockClear();
      await runWorktreeGcOnce({
        thresholdDays: 7,
        now: () => NOW,
        worktreeExists: () => true,
        revListCount: async () => 0,
        isWorktreeDirty: async () => false,
        removeWorktree: async () => {},
        keepWorktrees: true,
        resolveRepoRoot: () => "/tmp/repo",
      });
      const call = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes("would remove worktree for run #71"));
      return call;
    }

    previews.push((await sweep()) ?? "MISSING-1");
    previews.push((await sweep()) ?? "MISSING-2");
    previews.push((await sweep()) ?? "MISSING-3");

    // The preview must fire on every sweep and report the SAME idle duration —
    // if keep mode had written an agent_messages row, sweeps 2+ would compute
    // idle≈0 and the preview would vanish / change.
    expect(previews[0]).toContain("10.0 days idle");
    expect(previews[1]).toBe(previews[0]);
    expect(previews[2]).toBe(previews[0]);
    // And no rows were ever written to bump the clock.
    expect(await db.select().from(agentMessages)).toHaveLength(0);
  });

  it("uses repository.default_branch as the base for rev-list", async () => {
    await db.insert(repositories)
      .values({
        id: "R-custom",
        name: "Custom",
        remote: "git@example.com:org/repo.git",
        localPath: "/tmp/custom",
        defaultBranch: "develop",
      });

    await db.insert(agentSessions)
      .values({
        id: 99,
        taskId: null,
        status: "idle",
        goal: "<implement>",
        toolsProfile: "orchestrator,repo_write",
        cwdStrategy: "worktree",
        branch: "claude/t-200-99",
        worktreePath: "/tmp/custom/.worktrees/99",
        repoId: "R-custom",
        startedAt: TEN_DAYS_AGO,
      });

    const seenBase: string[] = [];
    const result = await runWorktreeGcOnce({
      thresholdDays: 7,
      now: () => NOW,
      worktreeExists: () => true,
      revListCount: async (_wt, base) => {
        seenBase.push(base);
        return 0;
      },
      isWorktreeDirty: async () => false,
      removeWorktree: async () => {},
      pruneAdmin: async () => {},
      resolveRepoRoot: () => "/tmp/custom",
    });

    expect(result.removed).toBe(1);
    expect(seenBase).toEqual(["develop"]);
  });

  it("does not scan non-idle runs", async () => {
    await db.insert(agentSessions)
      .values({
        id: 3,
        taskId: null,
        status: "running",
        goal: "<implement>",
        toolsProfile: "orchestrator,repo_write",
        cwdStrategy: "worktree",
        branch: "claude/t-300-3",
        worktreePath: "/tmp/repo/.worktrees/3",
        repoId: "R-default",
        startedAt: TEN_DAYS_AGO,
      });

    const result = await runWorktreeGcOnce({
      thresholdDays: 7,
      now: () => NOW,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
      removeWorktree: async () => {},
      resolveRepoRoot: () => "/tmp/repo",
    });

    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("respects last agent_messages.created_at over startedAt for idle clock", async () => {
    // Run was started 30 days ago but had a fresh message 2 days ago →
    // should NOT be GC'd despite a stale startedAt.
    await db.insert(agentSessions)
      .values({
        id: 11,
        taskId: null,
        status: "idle",
        goal: "<implement>",
        toolsProfile: "orchestrator,repo_write",
        cwdStrategy: "worktree",
        branch: "claude/t-100-11",
        worktreePath: "/tmp/repo/.worktrees/11",
        repoId: "R-default",
        startedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      });
    await db.insert(agentMessages)
      .values({
        runId: 11,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "hi" }]),
        createdAt: TWO_DAYS_AGO,
      });

    const removeWorktree = vi.fn(async () => {});
    const result = await runWorktreeGcOnce({
      thresholdDays: 7,
      now: () => NOW,
      worktreeExists: () => true,
      revListCount: async () => 0,
      isWorktreeDirty: async () => false,
      removeWorktree,
      resolveRepoRoot: () => "/tmp/repo",
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("keeps worktrees with commits ahead of base", async () => {
    await db.insert(agentSessions)
      .values({
        id: 55,
        taskId: null,
        status: "idle",
        goal: "<implement>",
        toolsProfile: "orchestrator,repo_write",
        cwdStrategy: "worktree",
        branch: "claude/t-400-55",
        worktreePath: "/tmp/repo/.worktrees/55",
        repoId: "R-default",
        startedAt: TEN_DAYS_AGO,
      });

    const removeWorktree = vi.fn(async () => {});
    const result = await runWorktreeGcOnce({
      thresholdDays: 7,
      now: () => NOW,
      worktreeExists: () => true,
      revListCount: async () => 4,
      isWorktreeDirty: async () => false,
      removeWorktree,
      resolveRepoRoot: () => "/tmp/repo",
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(removeWorktree).not.toHaveBeenCalled();
    // No system message either.
    const msgs = await db.select().from(agentMessages);
    expect(msgs).toHaveLength(0);
  });
});
