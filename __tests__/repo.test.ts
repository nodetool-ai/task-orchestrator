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
import * as validators from "../lib/validators";

beforeEach(() => {
  // Reverse-FK order so parent-cascade can't bite us if FKs ever get tightened.
  db.delete(agentMessages).run();
  db.delete(agentEvents).run();
  db.delete(agentSessions).run();
  db.delete(acceptanceCriteria).run();
  db.delete(taskNotes).run();
  db.delete(taskDependencies).run();
  db.delete(tasks).run();
  db.delete(plans).run();
  // Keep the seeded R-default repo; clear the rest so each test starts clean.
  db.delete(repositories).where(ne(repositories.id, "R-default")).run();
});

describe("plans", () => {
  it("derives ID from title and date", () => {
    const p = repo.createPlan({ title: "Hello World", date: "2026-01-15" });
    expect(p.id).toBe("P-2026-01-15-hello-world");
    expect(p.state).toBe("draft");
  });

  it("rejects duplicate ID", () => {
    repo.createPlan({ title: "Same", date: "2026-01-15" });
    expect(() => repo.createPlan({ title: "Same", date: "2026-01-15" })).toThrow(/already/);
  });

  it("rejects invalid state transitions", () => {
    const p = repo.createPlan({ title: "P", date: "2026-01-15" });
    expect(() => repo.updatePlan(p.id, { state: "done" })).toThrow(/transition/);
  });

  it("allows draft → accepted (skipping proposed)", () => {
    const p = repo.createPlan({ title: "P", date: "2026-01-15" });
    const after = repo.updatePlan(p.id, { state: "accepted" });
    expect(after.state).toBe("accepted");
  });

  it("preserves tags through round-trip", () => {
    const p = repo.createPlan({ title: "P", date: "2026-01-15", tags: ["a", "b"] });
    expect(repo.getPlan(p.id)!.tags).toEqual(["a", "b"]);
  });

  it("derives a valid, non-colliding ID for all-non-ASCII titles", () => {
    // Same regex the API enforces (SCHEMA.md / lib/validators.ts idPlanRe).
    const idPlanRe = /^P-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
    const a = repo.createPlan({ title: "日本語のタイトル", date: "2026-01-15" });
    const b = repo.createPlan({ title: "Кириллица", date: "2026-01-15" });
    // Neither slugifies to '' (which would be the invalid, colliding P-…-).
    expect(a.id).toMatch(idPlanRe);
    expect(b.id).toMatch(idPlanRe);
    // Distinct titles → distinct ids even though both slugs are empty.
    expect(a.id).not.toBe(b.id);
    // Deterministic: same title same day resolves to the same id → 409.
    expect(() => repo.createPlan({ title: "日本語のタイトル", date: "2026-01-15" })).toThrow(
      /already/
    );
  });
});

describe("tasks", () => {
  beforeEach(() => {
    repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
  });

  it("assigns sequential ID per day", () => {
    const a = repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = repo.createTask({ planId: "P-test", title: "B", date: "2026-01-15" });
    expect(a.id).toBe("T-20260115-0001");
    expect(b.id).toBe("T-20260115-0002");
  });

  it("rejects unknown plan", () => {
    expect(() => repo.createTask({ planId: "P-nope", title: "X" })).toThrow(/not found/);
  });

  it("rejects unknown dependency", () => {
    expect(() =>
      repo.createTask({
        planId: "P-test",
        title: "X",
        dependencies: ["T-99999999-9999"],
      })
    ).toThrow(/Dependencies not found/);
  });

  it("accepts known dependency", () => {
    const a = repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = repo.createTask({
      planId: "P-test",
      title: "B",
      date: "2026-01-15",
      dependencies: [a.id],
    });
    expect(b.dependencies).toEqual([a.id]);
  });

  it("filters by state and plan", () => {
    repo.createPlan({ id: "P-other", title: "Other", date: "2026-01-15" });
    const inPlan = repo.createTask({ planId: "P-test", title: "X", date: "2026-01-15" });
    repo.createTask({ planId: "P-other", title: "Y", date: "2026-01-15" });
    expect(repo.listTasks({ planId: "P-test" }).map((t) => t.id)).toEqual([inPlan.id]);
    expect(repo.listTasks({ state: "todo" }).length).toBe(2);
  });

  it("dedupes duplicate dependencies on create", () => {
    const a = repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = repo.createTask({
      planId: "P-test",
      title: "B",
      date: "2026-01-15",
      dependencies: [a.id, a.id],
    });
    expect(b.dependencies).toEqual([a.id]);
  });

  it("updateTask rejects a missing dependency with a 400, not a raw FK 500", () => {
    const t = repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" });
    expect(() =>
      repo.updateTask(t.id, { dependencies: ["T-99999999-9999"] })
    ).toThrow(/Dependencies not found/);
  });

  it("updateTask rejects a self-dependency", () => {
    const t = repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" });
    expect(() => repo.updateTask(t.id, { dependencies: [t.id] })).toThrow(/itself/);
  });

  it("updateTask dedupes duplicate dependencies", () => {
    const a = repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = repo.createTask({ planId: "P-test", title: "B", date: "2026-01-15" });
    const after = repo.updateTask(b.id, { dependencies: [a.id, a.id] });
    expect(after.dependencies).toEqual([a.id]);
  });

  it("updateTask persists a valid dependency set", () => {
    const a = repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = repo.createTask({ planId: "P-test", title: "B", date: "2026-01-15" });
    const after = repo.updateTask(b.id, { dependencies: [a.id] });
    expect(after.dependencies).toEqual([a.id]);
  });
});

describe("transitionTask", () => {
  let id: string;
  beforeEach(() => {
    repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
    id = repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" }).id;
  });

  it("rejects invalid transition (todo → done)", () => {
    expect(() => repo.transitionTask(id, { state: "done" })).toThrow(/Cannot transition/);
  });

  it("requires assignee to enter in_progress", () => {
    expect(() => repo.transitionTask(id, { state: "in_progress" })).toThrow(/assignee/);
  });

  it("permits todo → in_progress with assignee", () => {
    const t = repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    expect(t.state).toBe("in_progress");
    expect(t.assignee).toBe("alice");
  });

  it("rejects done while criteria are open", () => {
    repo.addCriterion(id, "ship it");
    repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    expect(() => repo.transitionTask(id, { state: "done" })).toThrow(/criteria/);
  });

  it("bypassCriteria forces done past open criteria", () => {
    repo.addCriterion(id, "ship it");
    repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    const after = repo.transitionTask(id, { state: "done", bypassCriteria: true });
    expect(after.state).toBe("done");
  });

  it("permits done when every criterion is checked", () => {
    repo.addCriterion(id, "ship it");
    repo.addCriterion(id, "tests pass");
    const t = repo.getTask(id)!;
    for (const c of t.criteria) repo.updateCriterion(c.id, { done: true });
    repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    const after = repo.transitionTask(id, { state: "done" });
    expect(after.state).toBe("done");
  });

  it("appends a note on every state change", () => {
    expect(repo.getTask(id)!.notes).toHaveLength(0);
    repo.transitionTask(id, { state: "in_progress", assignee: "alice", note: "starting" });
    const after = repo.getTask(id)!;
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0].body).toBe("starting");
    expect(after.notes[0].author).toBe("alice");
  });

  it("auto-notes the transition when no message is supplied", () => {
    repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    const after = repo.getTask(id)!;
    expect(after.notes[0].body).toMatch(/in_progress/);
  });

  it("locks done as a terminal state", () => {
    repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    repo.transitionTask(id, { state: "done" });
    expect(() => repo.transitionTask(id, { state: "in_progress", assignee: "alice" })).toThrow(
      /terminal/
    );
  });
});

describe("acceptance criteria", () => {
  let id: string;
  beforeEach(() => {
    repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
    id = repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" }).id;
  });

  it("appends in order with auto-incrementing position", () => {
    repo.addCriterion(id, "a");
    repo.addCriterion(id, "b");
    repo.addCriterion(id, "c");
    const criteria = repo.getTask(id)!.criteria;
    expect(criteria.map((c) => c.text)).toEqual(["a", "b", "c"]);
    expect(criteria.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it("toggling persists", () => {
    repo.addCriterion(id, "ship");
    const c = repo.getTask(id)!.criteria[0];
    repo.updateCriterion(c.id, { done: true });
    expect(repo.getTask(id)!.criteria[0].done).toBe(true);
    repo.updateCriterion(c.id, { done: false });
    expect(repo.getTask(id)!.criteria[0].done).toBe(false);
  });

  it("empty patch is a no-op, not a drizzle 'No values to set' 500", () => {
    repo.addCriterion(id, "ship");
    const c = repo.getTask(id)!.criteria[0];
    repo.updateCriterion(c.id, { done: true });
    // {} must neither throw nor clobber existing values.
    expect(() => repo.updateCriterion(c.id, {})).not.toThrow();
    const after = repo.getTask(id)!.criteria[0];
    expect(after.done).toBe(true);
    expect(after.text).toBe("ship");
  });

  it("updateCriterionSchema rejects an empty patch at the boundary", () => {
    const parsed = validators.updateCriterionSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

describe("notes", () => {
  let id: string;
  beforeEach(() => {
    repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
    id = repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" }).id;
  });

  it("appends and preserves order + attribution", () => {
    repo.addNote(id, "alice", "first");
    repo.addNote(id, "bob", "second");
    const notes = repo.getTask(id)!.notes;
    expect(notes.map((n) => n.body)).toEqual(["first", "second"]);
    expect(notes.map((n) => n.author)).toEqual(["alice", "bob"]);
  });
});

describe("plan progress", () => {
  beforeEach(() => {
    repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
  });

  it("excludes cancelled tasks from totals", () => {
    const a = repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = repo.createTask({ planId: "P-test", title: "B", date: "2026-01-15" });
    const c = repo.createTask({ planId: "P-test", title: "C", date: "2026-01-15" });
    repo.transitionTask(a.id, { state: "in_progress", assignee: "x" });
    repo.transitionTask(a.id, { state: "done" });
    repo.transitionTask(c.id, { state: "cancelled" });
    void b;
    const prog = repo.planProgress("P-test");
    expect(prog.total).toBe(2);
    expect(prog.done).toBe(1);
    expect(prog.pct).toBe(50);
  });
});

describe("repositories", () => {
  it("derives the id from the name slug", () => {
    const r = repo.createRepository({ name: "Hello World" });
    expect(r.id).toBe("R-hello-world");
    expect(r.name).toBe("Hello World");
    expect(r.defaultBranch).toBe("main");
  });

  it("rejects duplicates", () => {
    repo.createRepository({ name: "Same" });
    expect(() => repo.createRepository({ name: "Same" })).toThrow(/already/);
  });

  it("trims fields and treats empty strings as null", () => {
    const r = repo.createRepository({
      name: "Trimmy",
      remote: "  ",
      localPath: "",
      defaultBranch: "",
    });
    expect(r.remote).toBeNull();
    expect(r.localPath).toBeNull();
    expect(r.defaultBranch).toBe("main"); // empty falls back to default
  });

  it("updates fields", () => {
    const r = repo.createRepository({ name: "U" });
    const updated = repo.updateRepository(r.id, {
      localPath: "/tmp/u",
      defaultBranch: "trunk",
      description: "hello",
    });
    expect(updated.localPath).toBe("/tmp/u");
    expect(updated.defaultBranch).toBe("trunk");
    expect(updated.description).toBe("hello");
  });

  it("rejects empty name on update", () => {
    const r = repo.createRepository({ name: "U" });
    expect(() => repo.updateRepository(r.id, { name: "" })).toThrow(/empty/);
  });

  it("blocks delete while plans reference it (via attached repo)", () => {
    const r = repo.createRepository({ name: "Linked", localPath: "/tmp/x" });
    repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [r.id] });
    expect(() => repo.deleteRepository(r.id)).toThrow(/reference/);
  });

  it("allows delete once references are removed", () => {
    const r = repo.createRepository({ name: "Unlink" });
    const p = repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [r.id] });
    repo.updatePlan(p.id, { repoIds: [] });
    expect(() => repo.deleteRepository(r.id)).not.toThrow();
    expect(repo.getRepository(r.id)).toBeNull();
  });
});

describe("plan ↔ repository M2M", () => {
  it("defaults a new plan to the default repository", () => {
    expect(repo.defaultRepoId()).toBe("R-default");
    const p = repo.createPlan({ title: "A", date: "2026-01-15" });
    expect(p.repos.map((r) => r.id)).toEqual(["R-default"]);
  });

  it("accepts multiple repos on create", () => {
    const a = repo.createRepository({ name: "A" });
    const b = repo.createRepository({ name: "B" });
    const p = repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    expect(p.repos.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("preserves repo ordering by position", () => {
    const a = repo.createRepository({ name: "A" });
    const b = repo.createRepository({ name: "B" });
    const c = repo.createRepository({ name: "C" });
    const p = repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [c.id, a.id, b.id],
    });
    expect(p.repos.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });

  it("rejects an unknown repo on create", () => {
    expect(() =>
      repo.createPlan({ title: "P", date: "2026-01-15", repoIds: ["R-nope"] })
    ).toThrow(/not found/);
  });

  it("replaces the entire repo set via updatePlan", () => {
    const a = repo.createRepository({ name: "A" });
    const b = repo.createRepository({ name: "B" });
    const p = repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [a.id] });
    const after = repo.updatePlan(p.id, { repoIds: [b.id] });
    expect(after.repos.map((r) => r.id)).toEqual([b.id]);
  });

  it("add_plan_repository is idempotent and append-positioned", () => {
    const a = repo.createRepository({ name: "A" });
    const b = repo.createRepository({ name: "B" });
    const p = repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [a.id] });
    const after = repo.addPlanRepository(p.id, b.id);
    expect(after.repos.map((r) => r.id)).toEqual([a.id, b.id]);
    // idempotent: re-adding doesn't dup
    const again = repo.addPlanRepository(p.id, b.id);
    expect(again.repos.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("updatePlan unsets task.repoId for tasks pinned to a now-removed repo", () => {
    const a = repo.createRepository({ name: "A" });
    const b = repo.createRepository({ name: "B" });
    const plan = repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    const pinnedToB = repo.createTask({
      planId: plan.id,
      title: "T",
      date: "2026-01-15",
      repoId: b.id,
    });
    const pinnedToA = repo.createTask({
      planId: plan.id,
      title: "U",
      date: "2026-01-15",
      repoId: a.id,
    });
    // Narrow the plan to just A; B leaves the plan.
    repo.updatePlan(plan.id, { repoIds: [a.id] });
    // Task pinned to the removed repo B is unpinned; the one on A is untouched.
    expect(repo.getTask(pinnedToB.id)!.repoId).toBeNull();
    expect(repo.getTask(pinnedToA.id)!.repoId).toBe(a.id);
  });

  it("updatePlan with an empty repo set unpins every task", () => {
    const a = repo.createRepository({ name: "A" });
    const plan = repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [a.id] });
    const t = repo.createTask({
      planId: plan.id,
      title: "T",
      date: "2026-01-15",
      repoId: a.id,
    });
    repo.updatePlan(plan.id, { repoIds: [] });
    expect(repo.getTask(t.id)!.repoId).toBeNull();
  });

  it("addPlanRepository appends after a removal instead of colliding on position", () => {
    const b = repo.createRepository({ name: "B" });
    const c = repo.createRepository({ name: "C" });
    const a = repo.createRepository({ name: "A" }); // id sorts before C
    const plan = repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [b.id, c.id],
    });
    // Remove the primary B; C stays at position 1 (positions are not compacted).
    repo.removePlanRepository(plan.id, b.id);
    // Re-add A. With the row-count bug it would land at position 1 (== C) and,
    // since A's id sorts first, jump ahead of C. It must append after C instead.
    const after = repo.addPlanRepository(plan.id, a.id);
    expect(after.repos.map((r) => r.id)).toEqual([c.id, a.id]);
    // C remains the plan's primary (repos[0]) for plan-level runs.
    expect(after.repos[0].id).toBe(c.id);
  });

  it("remove_plan_repository unsets task.repoId for tasks pinned to it", () => {
    const a = repo.createRepository({ name: "A" });
    const b = repo.createRepository({ name: "B" });
    const plan = repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    const t = repo.createTask({
      planId: plan.id,
      title: "T",
      date: "2026-01-15",
      repoId: b.id,
    });
    expect(t.repoId).toBe(b.id);
    repo.removePlanRepository(plan.id, b.id);
    const after = repo.getTask(t.id)!;
    expect(after.repoId).toBeNull();
  });
});

describe("task ↔ repository", () => {
  it("inherits the plan's repo when the plan has exactly one", () => {
    const r = repo.createRepository({ name: "Solo", localPath: "/tmp/s" });
    const plan = repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [r.id] });
    const t = repo.createTask({ planId: plan.id, title: "T", date: "2026-01-15" });
    expect(t.repoId).toBe(r.id);
  });

  it("requires repo_id when the plan has multiple repos", () => {
    const a = repo.createRepository({ name: "A" });
    const b = repo.createRepository({ name: "B" });
    const plan = repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    expect(() =>
      repo.createTask({ planId: plan.id, title: "T", date: "2026-01-15" })
    ).toThrow(/repo_id/);
  });

  it("rejects a repo_id that's not on the plan", () => {
    const a = repo.createRepository({ name: "A" });
    const b = repo.createRepository({ name: "B" });
    const plan = repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [a.id] });
    expect(() =>
      repo.createTask({
        planId: plan.id,
        title: "T",
        date: "2026-01-15",
        repoId: b.id,
      })
    ).toThrow(/not attached/);
  });

  it("uses task.repoId at resolution, not the plan's set", () => {
    const a = repo.createRepository({ name: "A", localPath: "/tmp/a" });
    const b = repo.createRepository({ name: "B", localPath: "/tmp/b" });
    const plan = repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    const t = repo.createTask({
      planId: plan.id,
      title: "T",
      date: "2026-01-15",
      repoId: b.id,
    });
    const resolved = repo.resolveRepoForTask(t.id);
    expect(resolved?.id).toBe(b.id);
  });
});

describe("task prUrl (latest run's PR)", () => {
  function makeTask() {
    const plan = repo.createPlan({ title: "PR Plan", date: "2026-01-15" });
    return repo.createTask({ planId: plan.id, title: "T", date: "2026-01-15" });
  }
  function addRun(taskId: string, prUrl: string | null) {
    db.insert(agentSessions)
      .values({ taskId, goal: "<implement>", status: "completed", prUrl })
      .run();
  }

  it("is null when no run has opened a PR", () => {
    const t = makeTask();
    addRun(t.id, null);
    expect(repo.getTask(t.id)!.prUrl).toBeNull();
    expect(repo.listTasks({ planId: t.planId })[0].prUrl).toBeNull();
  });

  it("surfaces the most recent run's PR on getTask and listTasks", () => {
    const t = makeTask();
    addRun(t.id, "https://github.com/o/r/pull/1");
    addRun(t.id, "https://github.com/o/r/pull/2"); // later run wins
    expect(repo.getTask(t.id)!.prUrl).toBe("https://github.com/o/r/pull/2");
    const listed = repo.listTasks({ planId: t.planId }).find((x) => x.id === t.id)!;
    expect(listed.prUrl).toBe("https://github.com/o/r/pull/2");
  });
});
