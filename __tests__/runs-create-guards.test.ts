// __tests__/runs-create-guards.test.ts
//
// create() must validate the worktree invariants BEFORE inserting the row.
// Validating after the insert (the old behaviour) still returned the intended
// 400, but left behind a 'pending' agent_runs row that nothing ever drives —
// kickoff never started, and neither orphan reaper covers a taskless 'pending'
// run. The ghost then showed up permanently in the /runs UI "Idle" group.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, list } from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";

beforeEach(() => {
  seedPersonas();
  db.delete(agentSessions).run();
});

describe("create() worktree invariant guards", () => {
  it("rejects a worktree run with no taskId and leaves NO row behind", () => {
    expect(() => create({ goal: "<implement>", cwdStrategy: "worktree" })).toThrow(
      /taskId/
    );
    // The invariant is checked before db.insert, so no ghost 'pending' run.
    expect(list().length).toBe(0);
  });

  it("rejects a worktree_at_pr run with no prUrl and leaves NO row behind", () => {
    expect(() =>
      create({ goal: "<review>", cwdStrategy: "worktree_at_pr", taskId: null })
    ).toThrow(/prUrl/);
    expect(list().length).toBe(0);
  });

  it("still creates a row for a deferred worktree run without a taskId", () => {
    // defer skips the kickoff (and thus the invariant), matching the chat-box /
    // bare-test path — the row is intentionally allowed.
    const run = create({ goal: "<implement>", cwdStrategy: "worktree", defer: true });
    expect(run.status).toBe("idle");
    expect(list().length).toBe(1);
  });
});
