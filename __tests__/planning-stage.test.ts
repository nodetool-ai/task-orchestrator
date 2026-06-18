import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentEvents, agentMessages, agentSessions } from "../db/schema";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";

beforeEach(() => {
  db.delete(agentMessages).run();
  db.delete(agentEvents).run();
  db.delete(agentSessions).run();
  // runs.create defaults persona_id to 'implementor', which is an FK to
  // personas. Seed a minimal row so the insert satisfies the constraint.
  repo.upsertPersona({
    id: "implementor",
    name: "Implementor",
    systemPrompt: "test",
    modelProvider: "anthropic",
    modelId: "claude-sonnet-4-5",
    toolsProfile: "orchestrator,repo_write",
    skillPaths: [],
  });
});

describe("planning runs", () => {
  it("seeds planning_stage='gathering' for goal '<plan>'", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    expect(run.planningStage).toBe("gathering");
    // Round-trips through hydrateRun on re-read.
    expect(runs.get(run.id)!.planningStage).toBe("gathering");
  });

  it("leaves planning_stage NULL for ordinary runs", () => {
    const run = runs.create({ goal: "<chat>" });
    expect(run.planningStage).toBeNull();
    expect(runs.get(run.id)!.planningStage).toBeNull();
  });

  it("accepts the full legal forward arc", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    expect(repo.setPlanningStage(run.id, "spec_review")).toBe("spec_review");
    expect(repo.setPlanningStage(run.id, "building_plan")).toBe("building_plan");
    expect(repo.setPlanningStage(run.id, "plan_review")).toBe("plan_review");
    expect(repo.setPlanningStage(run.id, "committing")).toBe("committing");
    expect(repo.setPlanningStage(run.id, "done")).toBe("done");
    expect(runs.get(run.id)!.planningStage).toBe("done");
  });

  it("allows held-stage re-proposes (review self-loops)", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    repo.setPlanningStage(run.id, "spec_review");
    expect(repo.setPlanningStage(run.id, "spec_review")).toBe("spec_review");
    repo.setPlanningStage(run.id, "building_plan");
    repo.setPlanningStage(run.id, "plan_review");
    expect(repo.setPlanningStage(run.id, "plan_review")).toBe("plan_review");
  });

  it("rejects skipping a stage", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    expect(() => repo.setPlanningStage(run.id, "building_plan")).toThrow(/Illegal/);
    expect(() => repo.setPlanningStage(run.id, "done")).toThrow(/Illegal/);
  });

  it("rejects going backwards", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    repo.setPlanningStage(run.id, "spec_review");
    repo.setPlanningStage(run.id, "building_plan");
    expect(() => repo.setPlanningStage(run.id, "gathering")).toThrow(/Illegal/);
    expect(() => repo.setPlanningStage(run.id, "spec_review")).toThrow(/Illegal/);
  });

  it("rejects transitions out of the terminal 'done' stage", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    for (const s of ["spec_review", "building_plan", "plan_review", "committing", "done"] as const) {
      repo.setPlanningStage(run.id, s);
    }
    expect(() => repo.setPlanningStage(run.id, "committing")).toThrow(/Illegal/);
  });

  it("rejects setting a stage on a non-planning run", () => {
    const run = runs.create({ goal: "<chat>" });
    expect(() => repo.setPlanningStage(run.id, "spec_review")).toThrow(/not a planning run/);
  });

  it("rejects an unknown target stage", () => {
    const run = runs.create({ goal: "<plan>", defer: true });
    expect(() => repo.setPlanningStage(run.id, "bogus" as never)).toThrow(/Unknown/);
  });

  it("throws for a missing run", () => {
    expect(() => repo.setPlanningStage(999999, "spec_review")).toThrow(/not found/);
  });
});
