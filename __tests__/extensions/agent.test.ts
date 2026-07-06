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
import { makeRegistrar } from "../helpers/fake-registrar";

describe("orchestratorExtension", () => {
  it("registers 37 task_orch tools", () => {
    const r = makeRegistrar();
    orchestratorExtension({ author: "test" })(r.reg);
    expect(r.tools.size).toBe(37);
    for (const [name, def] of r.tools) {
      expect(name).toMatch(/^task_orch__/);
      expect(def.label).toBeDefined();
      expect(def.description).toBeDefined();
      expect(def.parameters).toBeDefined();
    }
  });
});

describe("orchestrator plan defaulting", () => {
  beforeEach(async () => {
    await db.delete(agentMessages);
    await db.delete(agentSessions);
    await db.delete(acceptanceCriteria);
    await db.delete(taskNotes);
    await db.delete(tasks);
    await db.delete(plans);
    await db.delete(repositories).where(ne(repositories.id, "R-default"));
  });

  function findTool(name: string) {
    const r = makeRegistrar();
    orchestratorExtension({ author: "test", defaultPlanId: "P-2026-05-27-test" })(r.reg);
    const hit = r.tools.get(`task_orch__${name}`);
    if (!hit) throw new Error(`tool ${name} not registered`);
    return hit;
  }

  it("defaults plan_id on get_plan when scoped to a plan", async () => {
    const p = await repo.createPlan({ title: "Test", date: "2026-05-27" });
    expect(p.id).toBe("P-2026-05-27-test");
    const def = findTool("get_plan");
    const result = await def.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toContain(p.id);
  });

  it("defaults plan_id on create_task when scoped to a plan", async () => {
    const p = await repo.createPlan({ title: "Test", date: "2026-05-27" });
    expect(p.id).toBe("P-2026-05-27-test");
    const def = findTool("create_task");
    const result = await def.execute("call-1", { title: "added by agent" });
    expect(result.isError).toBeFalsy();
    const created = await repo.listTasks({ planId: p.id });
    expect(created.length).toBe(1);
    expect(created[0].title).toBe("added by agent");
  });

  it("defaults plan_id on transition_plan when scoped to a plan", async () => {
    const p = await repo.createPlan({ title: "Test", date: "2026-05-27" });
    expect(p.id).toBe("P-2026-05-27-test");
    const def = findTool("transition_plan");
    const result = await def.execute("call-1", { state: "proposed" });
    expect(result.isError).toBeFalsy();
    expect((await repo.getPlan(p.id))?.state).toBe("proposed");
  });

  it("errors when no plan id is provided and none is scoped", async () => {
    const r = makeRegistrar();
    orchestratorExtension({ author: "test" })(r.reg); // no defaultPlanId
    const def = r.tools.get("task_orch__get_plan")!;
    const result = await def.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(/plan id required/);
  });
});
