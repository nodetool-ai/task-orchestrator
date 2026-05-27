import { beforeEach, describe, expect, it } from "vitest";
import { ne } from "drizzle-orm";
import { db } from "../../db";
import {
  acceptanceCriteria,
  agentMessages,
  agentSessions,
  plans,
  repositories,
  taskNotes,
  tasks,
} from "../../db/schema";
import * as repo from "../../lib/repo";
import { orchestratorExtension } from "../../lib/extensions/agent";

function makeStub() {
  const calls: Array<{ name: string; def: any }> = [];
  const pi: any = {
    registerTool: (def: any) => { calls.push({ name: def.name, def }); },
    on: () => {},
  };
  return { calls, pi };
}

describe("orchestratorExtension", () => {
  it("registers 31 task_orch tools", () => {
    const { calls, pi } = makeStub();
    orchestratorExtension({ author: "test" })(pi);
    expect(calls.length).toBe(31);
    for (const c of calls) {
      expect(c.name).toMatch(/^task_orch__/);
      expect(c.def.label).toBeDefined();
      expect(c.def.description).toBeDefined();
      expect(c.def.parameters).toBeDefined();
    }
  });
});

describe("orchestrator plan defaulting", () => {
  beforeEach(() => {
    db.delete(agentMessages).run();
    db.delete(agentSessions).run();
    db.delete(acceptanceCriteria).run();
    db.delete(taskNotes).run();
    db.delete(tasks).run();
    db.delete(plans).run();
    db.delete(repositories).where(ne(repositories.id, "R-default")).run();
  });

  function findTool(name: string) {
    const { calls, pi } = makeStub();
    orchestratorExtension({ author: "test", defaultPlanId: "P-2026-05-27-test" })(pi);
    const hit = calls.find((c) => c.name === `task_orch__${name}`);
    if (!hit) throw new Error(`tool ${name} not registered`);
    return hit.def;
  }

  it("defaults plan_id on get_plan when scoped to a plan", async () => {
    const p = repo.createPlan({ title: "Test", date: "2026-05-27" });
    expect(p.id).toBe("P-2026-05-27-test");
    const def = findTool("get_plan");
    const result = await def.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(p.id);
  });

  it("defaults plan_id on create_task when scoped to a plan", async () => {
    const p = repo.createPlan({ title: "Test", date: "2026-05-27" });
    expect(p.id).toBe("P-2026-05-27-test");
    const def = findTool("create_task");
    const result = await def.execute("call-1", { title: "added by agent" });
    expect(result.isError).toBeFalsy();
    const created = repo.listTasks({ planId: p.id });
    expect(created.length).toBe(1);
    expect(created[0].title).toBe("added by agent");
  });

  it("defaults plan_id on transition_plan when scoped to a plan", async () => {
    const p = repo.createPlan({ title: "Test", date: "2026-05-27" });
    expect(p.id).toBe("P-2026-05-27-test");
    const def = findTool("transition_plan");
    const result = await def.execute("call-1", { state: "proposed" });
    expect(result.isError).toBeFalsy();
    expect(repo.getPlan(p.id)?.state).toBe("proposed");
  });

  it("errors when no plan id is provided and none is scoped", async () => {
    const { calls, pi } = makeStub();
    orchestratorExtension({ author: "test" })(pi); // no defaultPlanId
    const def = calls.find((c) => c.name === "task_orch__get_plan")!.def;
    const result = await def.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/plan id required/);
  });
});
