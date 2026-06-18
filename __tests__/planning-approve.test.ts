import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentEvents, agentMessages, agentSessions } from "../db/schema";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";

beforeEach(() => {
  db.delete(agentMessages).run();
  db.delete(agentEvents).run();
  db.delete(agentSessions).run();
  // Seed the persona FK so runs.create won't reject the insert.
  repo.upsertPersona({
    id: "implementor",
    name: "Implementor",
    systemPrompt: "test",
    toolsProfile: "orchestrator,repo_write",
    skillPaths: [],
  });
});

// Helper: advance a planning run to a given stage.
function advanceTo(
  runId: number,
  ...stages: Array<"spec_review" | "building_plan" | "plan_review" | "committing" | "done">
) {
  for (const s of stages) {
    repo.setPlanningStage(runId, s);
  }
}

describe("approve_spec", () => {
  it("advances spec_review → building_plan", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    advanceTo(run.id, "spec_review");

    expect(run.planningStage).toBe("gathering");
    repo.setPlanningStage(run.id, "building_plan");
    const updated = runs.get(run.id)!;
    expect(updated.planningStage).toBe("building_plan");
  });

  it("rejects approve_spec from stages other than spec_review with 409-equivalent", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    // Still at 'gathering', not 'spec_review'
    expect(() => repo.setPlanningStage(run.id, "building_plan")).toThrow(/Illegal/);
  });

  it("rejects approve_spec from plan_review", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    advanceTo(run.id, "spec_review", "building_plan", "plan_review");
    expect(() => repo.setPlanningStage(run.id, "building_plan")).toThrow(/Illegal/);
  });
});

describe("approve_plan", () => {
  it("advances plan_review → committing", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    advanceTo(run.id, "spec_review", "building_plan", "plan_review");

    repo.setPlanningStage(run.id, "committing");
    const updated = runs.get(run.id)!;
    expect(updated.planningStage).toBe("committing");
  });

  it("rejects approve_plan from stages other than plan_review", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    // At 'gathering'
    expect(() => repo.setPlanningStage(run.id, "committing")).toThrow(/Illegal/);
  });

  it("rejects approve_plan from spec_review", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    advanceTo(run.id, "spec_review");
    expect(() => repo.setPlanningStage(run.id, "committing")).toThrow(/Illegal/);
  });
});

describe("stage guard (409 equivalent)", () => {
  it("wrong prior stage throws 409-equivalent RepoError", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    // approve_spec requires spec_review; we're at gathering
    let caught: unknown;
    try {
      repo.setPlanningStage(run.id, "building_plan");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(repo.RepoError);
    expect((caught as repo.RepoError).status).toBe(409);
  });

  it("non-planning run throws 400 (not a planning run)", () => {
    const run = runs.create({ goal: "<chat>" });
    let caught: unknown;
    try {
      repo.setPlanningStage(run.id, "spec_review");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(repo.RepoError);
    expect((caught as repo.RepoError).status).toBe(400);
  });
});

describe("planning run creation", () => {
  it("seeds planning_stage='gathering' for goal '<plan>'", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    expect(run.planningStage).toBe("gathering");
    expect(runs.get(run.id)!.planningStage).toBe("gathering");
  });

  it("leaves planning_stage null for ordinary runs", () => {
    const run = runs.create({ goal: "<chat>" });
    expect(run.planningStage).toBeNull();
  });

  it("planning run starts idle (no git lifecycle)", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    expect(run.status).toBe("idle");
  });
});
