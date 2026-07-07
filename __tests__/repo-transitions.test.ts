// __tests__/repo-transitions.test.ts
//
// M17a/M17b: transitionTask and updatePlan used to read a state snapshot,
// check the TASK_TRANSITIONS/PLAN_TRANSITIONS guard against it, and only
// then write — with await boundaries between each step. Two concurrent
// callers could both pass the guard against the same stale snapshot and the
// loser's write would silently clobber the winner's terminal state (e.g. a
// human's review→cancelled racing the PR-merge poller's review→done,
// producing a task that's both cancelled and done depending on write order —
// a composite the state machine explicitly forbids).
//
// Fixed by locking the row with SELECT ... FOR UPDATE inside a single
// db.transaction() and re-deriving the guard from the locked read, so
// concurrent transitions serialize: the loser re-reads the row *after* the
// winner committed and is rejected by the (now-correct) guard.
//
// These tests exercise the real race against the real Postgres test
// instance (localhost:5433) via Promise.all — no mocking of the DB layer.

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

/** Pull settle results apart into (exactly one) fulfilled and (exactly one) rejected. */
function splitSettled<T>(results: PromiseSettledResult<T>[]) {
  const fulfilled = results.filter(
    (r): r is PromiseFulfilledResult<T> => r.status === "fulfilled"
  );
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected"
  );
  return { fulfilled, rejected };
}

describe("transitionTask concurrency (M17a)", () => {
  it("serializes two concurrent transitions out of 'testing': exactly one wins, the loser is rejected, the winner's terminal state survives", async () => {
    await repo.createPlan({ id: "P-race", title: "Race", date: "2026-01-15" });
    const task = await repo.createTask({ planId: "P-race", title: "T", date: "2026-01-15" });
    await repo.transitionTask(task.id, { state: "in_progress", assignee: "alice" });
    await repo.transitionTask(task.id, { state: "testing" });

    // Verified failure scenario: a human cancels (testing→cancelled) while the
    // PR-merge poller marks merged (testing→merged). Both are legal *from*
    // testing, but merged and cancelled are mutually exclusive terminal
    // states — whichever commits first must make the other illegal.
    const results = await Promise.allSettled([
      repo.transitionTask(task.id, { state: "cancelled" }),
      repo.transitionTask(task.id, { state: "merged" }),
    ]);

    const { fulfilled, rejected } = splitSettled(results);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(repo.RepoError);
    expect((rejected[0].reason as Error).message).toMatch(/Cannot transition/);

    const winnerState = fulfilled[0].value.state;
    expect(["cancelled", "merged"]).toContain(winnerState);

    // No lost update / no composite state: the row reflects exactly the
    // winner, not a state the state machine forbids reaching from 'testing'
    // via both branches.
    const final = await repo.getTask(task.id);
    expect(final!.state).toBe(winnerState);
  });

  it("allows marking merged with open acceptance criteria", async () => {
    await repo.createPlan({ id: "P-crit", title: "Crit", date: "2026-01-15" });
    const task = await repo.createTask({ planId: "P-crit", title: "T", date: "2026-01-15" });
    await repo.addCriterion(task.id, "ship it");
    await repo.transitionTask(task.id, { state: "in_progress", assignee: "alice" });
    await repo.transitionTask(task.id, { state: "testing" });

    // Acceptance criteria are informational only — they must never block a
    // state transition, even when left unchecked.
    const after = await repo.transitionTask(task.id, { state: "merged" });
    expect(after.state).toBe("merged");
  });
});

describe("updatePlan concurrency (M17b)", () => {
  it("serializes two concurrent state changes out of 'accepted': exactly one wins, the loser is rejected", async () => {
    const plan = await repo.createPlan({ id: "P-planrace", title: "Plan Race", date: "2026-01-15" });
    await repo.updatePlan(plan.id, { state: "accepted" });

    // 'done' and 'cancelled' are both legal from 'accepted' but are mutually
    // exclusive terminal states (PLAN_TRANSITIONS['done'] = PLAN_TRANSITIONS['cancelled'] = []),
    // so whichever commits first makes the other illegal — a deterministic
    // way to prove the guard is re-derived from the locked row.
    const results = await Promise.allSettled([
      repo.updatePlan(plan.id, { state: "done" }),
      repo.updatePlan(plan.id, { state: "cancelled" }),
    ]);

    const { fulfilled, rejected } = splitSettled(results);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(repo.RepoError);
    expect((rejected[0].reason as Error).message).toMatch(/Cannot transition plan/);

    const winnerState = fulfilled[0].value.state;
    expect(["done", "cancelled"]).toContain(winnerState);

    const final = await repo.getPlan(plan.id);
    expect(final!.state).toBe(winnerState);
  });
});
