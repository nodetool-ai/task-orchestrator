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

describe("plans", () => {
  it("derives ID from title and date", async () => {
    const p = await repo.createPlan({ title: "Hello World", date: "2026-01-15" });
    expect(p.id).toBe("P-2026-01-15-hello-world");
    expect(p.state).toBe("draft");
  });

  it("rejects duplicate ID", async () => {
    await repo.createPlan({ title: "Same", date: "2026-01-15" });
    await expect(repo.createPlan({ title: "Same", date: "2026-01-15" })).rejects.toThrow(/already/);
  });

  it("rejects invalid state transitions", async () => {
    const p = await repo.createPlan({ title: "P", date: "2026-01-15" });
    await expect(repo.updatePlan(p.id, { state: "done" })).rejects.toThrow(/transition/);
  });

  it("allows draft → accepted (skipping proposed)", async () => {
    const p = await repo.createPlan({ title: "P", date: "2026-01-15" });
    const after = await repo.updatePlan(p.id, { state: "accepted" });
    expect(after.state).toBe("accepted");
  });

  it("preserves tags through round-trip", async () => {
    const p = await repo.createPlan({ title: "P", date: "2026-01-15", tags: ["a", "b"] });
    expect((await repo.getPlan(p.id))!.tags).toEqual(["a", "b"]);
  });

  it("derives a valid, non-colliding ID for all-non-ASCII titles", async () => {
    // Same regex the API enforces (SCHEMA.md / lib/validators.ts idPlanRe).
    const idPlanRe = /^P-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
    const a = await repo.createPlan({ title: "日本語のタイトル", date: "2026-01-15" });
    const b = await repo.createPlan({ title: "Кириллица", date: "2026-01-15" });
    // Neither slugifies to '' (which would be the invalid, colliding P-…-).
    expect(a.id).toMatch(idPlanRe);
    expect(b.id).toMatch(idPlanRe);
    // Distinct titles → distinct ids even though both slugs are empty.
    expect(a.id).not.toBe(b.id);
    // Deterministic: same title same day resolves to the same id → 409.
    await expect(repo.createPlan({ title: "日本語のタイトル", date: "2026-01-15" })).rejects.toThrow(
      /already/
    );
  });
});

describe("tasks", () => {
  beforeEach(async () => {
    await repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
  });

  it("assigns sequential ID per day", async () => {
    const a = await repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = await repo.createTask({ planId: "P-test", title: "B", date: "2026-01-15" });
    expect(a.id).toBe("T-20260115-0001");
    expect(b.id).toBe("T-20260115-0002");
  });

  it("rejects unknown plan", async () => {
    await expect(repo.createTask({ planId: "P-nope", title: "X" })).rejects.toThrow(/not found/);
  });

  it("rejects unknown dependency", async () => {
    await expect(
      repo.createTask({
        planId: "P-test",
        title: "X",
        dependencies: ["T-99999999-9999"],
      })
    ).rejects.toThrow(/Dependencies not found/);
  });

  it("accepts known dependency", async () => {
    const a = await repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = await repo.createTask({
      planId: "P-test",
      title: "B",
      date: "2026-01-15",
      dependencies: [a.id],
    });
    expect(b.dependencies).toEqual([a.id]);
  });

  it("filters by state and plan", async () => {
    await repo.createPlan({ id: "P-other", title: "Other", date: "2026-01-15" });
    const inPlan = await repo.createTask({ planId: "P-test", title: "X", date: "2026-01-15" });
    await repo.createTask({ planId: "P-other", title: "Y", date: "2026-01-15" });
    expect((await repo.listTasks({ planId: "P-test" })).map((t) => t.id)).toEqual([inPlan.id]);
    expect((await repo.listTasks({ state: "todo" })).length).toBe(2);
  });

  it("dedupes duplicate dependencies on create", async () => {
    const a = await repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = await repo.createTask({
      planId: "P-test",
      title: "B",
      date: "2026-01-15",
      dependencies: [a.id, a.id],
    });
    expect(b.dependencies).toEqual([a.id]);
  });

  it("updateTask rejects a missing dependency with a 400, not a raw FK 500", async () => {
    const t = await repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" });
    await expect(
      repo.updateTask(t.id, { dependencies: ["T-99999999-9999"] })
    ).rejects.toThrow(/Dependencies not found/);
  });

  it("updateTask rejects a self-dependency", async () => {
    const t = await repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" });
    await expect(repo.updateTask(t.id, { dependencies: [t.id] })).rejects.toThrow(/itself/);
  });

  it("updateTask dedupes duplicate dependencies", async () => {
    const a = await repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = await repo.createTask({ planId: "P-test", title: "B", date: "2026-01-15" });
    const after = await repo.updateTask(b.id, { dependencies: [a.id, a.id] });
    expect(after.dependencies).toEqual([a.id]);
  });

  it("updateTask persists a valid dependency set", async () => {
    const a = await repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = await repo.createTask({ planId: "P-test", title: "B", date: "2026-01-15" });
    const after = await repo.updateTask(b.id, { dependencies: [a.id] });
    expect(after.dependencies).toEqual([a.id]);
  });
});

describe("transitionTask", () => {
  let id: string;
  beforeEach(async () => {
    await repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
    id = (await repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" })).id;
  });

  it("rejects invalid transition (todo → done)", async () => {
    await expect(repo.transitionTask(id, { state: "done" })).rejects.toThrow(/Cannot transition/);
  });

  it("requires assignee to enter in_progress", async () => {
    await expect(repo.transitionTask(id, { state: "in_progress" })).rejects.toThrow(/assignee/);
  });

  it("permits todo → in_progress with assignee", async () => {
    const t = await repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    expect(t.state).toBe("in_progress");
    expect(t.assignee).toBe("alice");
  });

  it("rejects done while criteria are open", async () => {
    await repo.addCriterion(id, "ship it");
    await repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    await expect(repo.transitionTask(id, { state: "done" })).rejects.toThrow(/criteria/);
  });

  it("bypassCriteria forces done past open criteria", async () => {
    await repo.addCriterion(id, "ship it");
    await repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    const after = await repo.transitionTask(id, { state: "done", bypassCriteria: true });
    expect(after.state).toBe("done");
  });

  it("permits done when every criterion is checked", async () => {
    await repo.addCriterion(id, "ship it");
    await repo.addCriterion(id, "tests pass");
    const t = (await repo.getTask(id))!;
    for (const c of t.criteria) await repo.updateCriterion(c.id, { done: true });
    await repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    const after = await repo.transitionTask(id, { state: "done" });
    expect(after.state).toBe("done");
  });

  it("appends a note on every state change", async () => {
    expect((await repo.getTask(id))!.notes).toHaveLength(0);
    await repo.transitionTask(id, { state: "in_progress", assignee: "alice", note: "starting" });
    const after = (await repo.getTask(id))!;
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0].body).toBe("starting");
    expect(after.notes[0].author).toBe("alice");
  });

  it("auto-notes the transition when no message is supplied", async () => {
    await repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    const after = (await repo.getTask(id))!;
    expect(after.notes[0].body).toMatch(/in_progress/);
  });

  it("locks done as a terminal state", async () => {
    await repo.transitionTask(id, { state: "in_progress", assignee: "alice" });
    await repo.transitionTask(id, { state: "done" });
    await expect(repo.transitionTask(id, { state: "in_progress", assignee: "alice" })).rejects.toThrow(
      /terminal/
    );
  });
});

describe("acceptance criteria", () => {
  let id: string;
  beforeEach(async () => {
    await repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
    id = (await repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" })).id;
  });

  it("appends in order with auto-incrementing position", async () => {
    await repo.addCriterion(id, "a");
    await repo.addCriterion(id, "b");
    await repo.addCriterion(id, "c");
    const criteria = (await repo.getTask(id))!.criteria;
    expect(criteria.map((c) => c.text)).toEqual(["a", "b", "c"]);
    expect(criteria.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it("toggling persists", async () => {
    await repo.addCriterion(id, "ship");
    const c = (await repo.getTask(id))!.criteria[0];
    await repo.updateCriterion(c.id, { done: true });
    expect((await repo.getTask(id))!.criteria[0].done).toBe(true);
    await repo.updateCriterion(c.id, { done: false });
    expect((await repo.getTask(id))!.criteria[0].done).toBe(false);
  });

  it("empty patch is a no-op, not a drizzle 'No values to set' 500", async () => {
    await repo.addCriterion(id, "ship");
    const c = (await repo.getTask(id))!.criteria[0];
    await repo.updateCriterion(c.id, { done: true });
    // {} must neither throw nor clobber existing values.
    await expect(repo.updateCriterion(c.id, {})).resolves.not.toThrow();
    const after = (await repo.getTask(id))!.criteria[0];
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
  beforeEach(async () => {
    await repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
    id = (await repo.createTask({ planId: "P-test", title: "T", date: "2026-01-15" })).id;
  });

  it("appends and preserves order + attribution", async () => {
    await repo.addNote(id, "alice", "first");
    await repo.addNote(id, "bob", "second");
    const notes = (await repo.getTask(id))!.notes;
    expect(notes.map((n) => n.body)).toEqual(["first", "second"]);
    expect(notes.map((n) => n.author)).toEqual(["alice", "bob"]);
  });
});

describe("plan progress", () => {
  beforeEach(async () => {
    await repo.createPlan({ id: "P-test", title: "Test", date: "2026-01-15" });
  });

  it("excludes cancelled tasks from totals", async () => {
    const a = await repo.createTask({ planId: "P-test", title: "A", date: "2026-01-15" });
    const b = await repo.createTask({ planId: "P-test", title: "B", date: "2026-01-15" });
    const c = await repo.createTask({ planId: "P-test", title: "C", date: "2026-01-15" });
    await repo.transitionTask(a.id, { state: "in_progress", assignee: "x" });
    await repo.transitionTask(a.id, { state: "done" });
    await repo.transitionTask(c.id, { state: "cancelled" });
    void b;
    const prog = await repo.planProgress("P-test");
    expect(prog.total).toBe(2);
    expect(prog.done).toBe(1);
    expect(prog.pct).toBe(50);
  });
});

describe("repositories", () => {
  it("derives the id from the name slug", async () => {
    const r = await repo.createRepository({ name: "Hello World" });
    expect(r.id).toBe("R-hello-world");
    expect(r.name).toBe("Hello World");
    expect(r.defaultBranch).toBe("main");
  });

  it("rejects duplicates", async () => {
    await repo.createRepository({ name: "Same" });
    await expect(repo.createRepository({ name: "Same" })).rejects.toThrow(/already/);
  });

  it("trims fields and treats empty strings as null", async () => {
    const r = await repo.createRepository({
      name: "Trimmy",
      remote: "  ",
      localPath: "",
      defaultBranch: "",
    });
    expect(r.remote).toBeNull();
    expect(r.localPath).toBeNull();
    expect(r.defaultBranch).toBe("main"); // empty falls back to default
  });

  it("updates fields", async () => {
    const r = await repo.createRepository({ name: "U" });
    const updated = await repo.updateRepository(r.id, {
      localPath: "/tmp/u",
      defaultBranch: "trunk",
      description: "hello",
    });
    expect(updated.localPath).toBe("/tmp/u");
    expect(updated.defaultBranch).toBe("trunk");
    expect(updated.description).toBe("hello");
  });

  it("rejects empty name on update", async () => {
    const r = await repo.createRepository({ name: "U" });
    await expect(repo.updateRepository(r.id, { name: "" })).rejects.toThrow(/empty/);
  });

  it("blocks delete while plans reference it (via attached repo)", async () => {
    const r = await repo.createRepository({ name: "Linked", localPath: "/tmp/x" });
    await repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [r.id] });
    await expect(repo.deleteRepository(r.id)).rejects.toThrow(/reference/);
  });

  it("allows delete once references are removed", async () => {
    const r = await repo.createRepository({ name: "Unlink" });
    const p = await repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [r.id] });
    await repo.updatePlan(p.id, { repoIds: [] });
    await expect(repo.deleteRepository(r.id)).resolves.not.toThrow();
    expect(await repo.getRepository(r.id)).toBeNull();
  });
});

describe("plan ↔ repository M2M", () => {
  it("defaults a new plan to the default repository", async () => {
    expect(await repo.defaultRepoId()).toBe("R-default");
    const p = await repo.createPlan({ title: "A", date: "2026-01-15" });
    expect(p.repos.map((r) => r.id)).toEqual(["R-default"]);
  });

  it("accepts multiple repos on create", async () => {
    const a = await repo.createRepository({ name: "A" });
    const b = await repo.createRepository({ name: "B" });
    const p = await repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    expect(p.repos.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("preserves repo ordering by position", async () => {
    const a = await repo.createRepository({ name: "A" });
    const b = await repo.createRepository({ name: "B" });
    const c = await repo.createRepository({ name: "C" });
    const p = await repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [c.id, a.id, b.id],
    });
    expect(p.repos.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });

  it("rejects an unknown repo on create", async () => {
    await expect(
      repo.createPlan({ title: "P", date: "2026-01-15", repoIds: ["R-nope"] })
    ).rejects.toThrow(/not found/);
  });

  it("replaces the entire repo set via updatePlan", async () => {
    const a = await repo.createRepository({ name: "A" });
    const b = await repo.createRepository({ name: "B" });
    const p = await repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [a.id] });
    const after = await repo.updatePlan(p.id, { repoIds: [b.id] });
    expect(after.repos.map((r) => r.id)).toEqual([b.id]);
  });

  it("add_plan_repository is idempotent and append-positioned", async () => {
    const a = await repo.createRepository({ name: "A" });
    const b = await repo.createRepository({ name: "B" });
    const p = await repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [a.id] });
    const after = await repo.addPlanRepository(p.id, b.id);
    expect(after.repos.map((r) => r.id)).toEqual([a.id, b.id]);
    // idempotent: re-adding doesn't dup
    const again = await repo.addPlanRepository(p.id, b.id);
    expect(again.repos.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("updatePlan unsets task.repoId for tasks pinned to a now-removed repo", async () => {
    const a = await repo.createRepository({ name: "A" });
    const b = await repo.createRepository({ name: "B" });
    const plan = await repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    const pinnedToB = await repo.createTask({
      planId: plan.id,
      title: "T",
      date: "2026-01-15",
      repoId: b.id,
    });
    const pinnedToA = await repo.createTask({
      planId: plan.id,
      title: "U",
      date: "2026-01-15",
      repoId: a.id,
    });
    // Narrow the plan to just A; B leaves the plan.
    await repo.updatePlan(plan.id, { repoIds: [a.id] });
    // Task pinned to the removed repo B is unpinned; the one on A is untouched.
    expect((await repo.getTask(pinnedToB.id))!.repoId).toBeNull();
    expect((await repo.getTask(pinnedToA.id))!.repoId).toBe(a.id);
  });

  it("updatePlan with an empty repo set unpins every task", async () => {
    const a = await repo.createRepository({ name: "A" });
    const plan = await repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [a.id] });
    const t = await repo.createTask({
      planId: plan.id,
      title: "T",
      date: "2026-01-15",
      repoId: a.id,
    });
    await repo.updatePlan(plan.id, { repoIds: [] });
    expect((await repo.getTask(t.id))!.repoId).toBeNull();
  });

  it("addPlanRepository appends after a removal instead of colliding on position", async () => {
    const b = await repo.createRepository({ name: "B" });
    const c = await repo.createRepository({ name: "C" });
    const a = await repo.createRepository({ name: "A" }); // id sorts before C
    const plan = await repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [b.id, c.id],
    });
    // Remove the primary B; C stays at position 1 (positions are not compacted).
    await repo.removePlanRepository(plan.id, b.id);
    // Re-add A. With the row-count bug it would land at position 1 (== C) and,
    // since A's id sorts first, jump ahead of C. It must append after C instead.
    const after = await repo.addPlanRepository(plan.id, a.id);
    expect(after.repos.map((r) => r.id)).toEqual([c.id, a.id]);
    // C remains the plan's primary (repos[0]) for plan-level runs.
    expect(after.repos[0].id).toBe(c.id);
  });

  it("remove_plan_repository unsets task.repoId for tasks pinned to it", async () => {
    const a = await repo.createRepository({ name: "A" });
    const b = await repo.createRepository({ name: "B" });
    const plan = await repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    const t = await repo.createTask({
      planId: plan.id,
      title: "T",
      date: "2026-01-15",
      repoId: b.id,
    });
    expect(t.repoId).toBe(b.id);
    await repo.removePlanRepository(plan.id, b.id);
    const after = (await repo.getTask(t.id))!;
    expect(after.repoId).toBeNull();
  });
});

describe("task ↔ repository", () => {
  it("inherits the plan's repo when the plan has exactly one", async () => {
    const r = await repo.createRepository({ name: "Solo", localPath: "/tmp/s" });
    const plan = await repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [r.id] });
    const t = await repo.createTask({ planId: plan.id, title: "T", date: "2026-01-15" });
    expect(t.repoId).toBe(r.id);
  });

  it("requires repo_id when the plan has multiple repos", async () => {
    const a = await repo.createRepository({ name: "A" });
    const b = await repo.createRepository({ name: "B" });
    const plan = await repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    await expect(
      repo.createTask({ planId: plan.id, title: "T", date: "2026-01-15" })
    ).rejects.toThrow(/repo_id/);
  });

  it("rejects a repo_id that's not on the plan", async () => {
    const a = await repo.createRepository({ name: "A" });
    const b = await repo.createRepository({ name: "B" });
    const plan = await repo.createPlan({ title: "P", date: "2026-01-15", repoIds: [a.id] });
    await expect(
      repo.createTask({
        planId: plan.id,
        title: "T",
        date: "2026-01-15",
        repoId: b.id,
      })
    ).rejects.toThrow(/not attached/);
  });

  it("uses task.repoId at resolution, not the plan's set", async () => {
    const a = await repo.createRepository({ name: "A", localPath: "/tmp/a" });
    const b = await repo.createRepository({ name: "B", localPath: "/tmp/b" });
    const plan = await repo.createPlan({
      title: "P",
      date: "2026-01-15",
      repoIds: [a.id, b.id],
    });
    const t = await repo.createTask({
      planId: plan.id,
      title: "T",
      date: "2026-01-15",
      repoId: b.id,
    });
    const resolved = await repo.resolveRepoForTask(t.id);
    expect(resolved?.id).toBe(b.id);
  });
});

describe("task prUrl (latest run's PR)", () => {
  async function makeTask() {
    const plan = await repo.createPlan({ title: "PR Plan", date: "2026-01-15" });
    return repo.createTask({ planId: plan.id, title: "T", date: "2026-01-15" });
  }
  async function addRun(taskId: string, prUrl: string | null) {
    await db
      .insert(agentSessions)
      .values({ taskId, goal: "<implement>", status: "completed", prUrl });
  }

  it("is null when no run has opened a PR", async () => {
    const t = await makeTask();
    await addRun(t.id, null);
    expect((await repo.getTask(t.id))!.prUrl).toBeNull();
    expect((await repo.listTasks({ planId: t.planId }))[0].prUrl).toBeNull();
  });

  it("surfaces the most recent run's PR on getTask and listTasks", async () => {
    const t = await makeTask();
    await addRun(t.id, "https://github.com/o/r/pull/1");
    await addRun(t.id, "https://github.com/o/r/pull/2"); // later run wins
    expect((await repo.getTask(t.id))!.prUrl).toBe("https://github.com/o/r/pull/2");
    const listed = (await repo.listTasks({ planId: t.planId })).find((x) => x.id === t.id)!;
    expect(listed.prUrl).toBe("https://github.com/o/r/pull/2");
  });
});
