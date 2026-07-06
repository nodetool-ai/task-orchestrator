import { describe, expect, it, beforeEach } from "vitest";
import { personaMemoryFactory } from "../../lib/extensions/persona-memory";
import { db } from "../../db";
import { personas as personasTable, personaMemories, agentSessions } from "../../db/schema";
import * as repo from "../../lib/repo";
import * as runs from "../../lib/runs";
import type { Persona } from "../../lib/personas/types";
import { makeRegistrar } from "../helpers/fake-registrar";

const persona: Persona = {
  id: "reviewer", name: "Reviewer", description: "",
  systemPrompt: "review code",
  toolsProfile: "repo_read"
};

const CWD = "/tmp/persona-mem-test";

// The memory tools resolve persona + scopes from the caller's run row
// server-side (workers hold no DB access), so each test mounts the factory
// against a REAL run carrying personaId 'reviewer' and the wanted scopes.
async function makeRun(opts: { taskId?: string; repoId?: string } = {}) {
  const run = await runs.create({
    goal: "<chat>",
    personaId: "reviewer",
    taskId: opts.taskId ?? null,
    repoId: opts.repoId ?? null,
    defer: true,
  } as any);
  return { id: run.id, taskId: run.taskId, repoId: run.repoId };
}

describe("personaMemoryFactory", () => {
  beforeEach(async () => {
    // Runs reference personas by FK — clear them before reseeding personas.
    await db.delete(agentSessions);
    await db.delete(personaMemories);
    await db.delete(personasTable);
    await db.insert(personasTable).values({
      id: "reviewer", name: "Reviewer", systemPrompt: "x",
      toolsProfile: "repo_read",
    });
  });

  it("adds an ambient skill with empty body when no memory exists", async () => {
    const r = makeRegistrar();
    const run = await makeRun();
    await personaMemoryFactory(persona, run, CWD)(r.reg);
    expect(r.skills.length).toBe(1);
    expect(r.skills[0].name).toBe("persona-memory-reviewer");
    expect(r.skills[0].description).toContain("Reviewer");
    expect(r.skills[0].body).toContain("(no notes yet)");
  });

  it("adds an ambient skill including bullets from each scope that has body", async () => {
    const repoRow = await repo.createRepository({ name: "mem-repo", defaultBranch: "main" });
    await repo.appendPersonaMemory("reviewer", "global", "always check tests");
    await repo.appendPersonaMemory("reviewer", repoRow.id, "this repo uses vitest");
    const r = makeRegistrar();
    const run = await makeRun({ repoId: repoRow.id });
    await personaMemoryFactory(persona, run, CWD)(r.reg);
    expect(r.skills[0].body).toContain("always check tests");
    expect(r.skills[0].body).toContain("this repo uses vitest");
  });

  it("registers memory_remember and memory_forget tools", async () => {
    const r = makeRegistrar();
    const run = await makeRun();
    await personaMemoryFactory(persona, run, CWD)(r.reg);
    expect(r.tools.has("memory_remember")).toBe(true);
    expect(r.tools.has("memory_forget")).toBe(true);
  });

  it("memory_remember at task scope persists to the task scope key", async () => {
    const plan = await repo.createPlan({ title: "Mem plan", date: "2026-07-06" });
    const task = await repo.createTask({ planId: plan.id, title: "Mem task", date: "2026-07-06" });
    const r = makeRegistrar();
    const run = await makeRun({ taskId: task.id });
    await personaMemoryFactory(persona, run, CWD)(r.reg);
    const def = r.tools.get("memory_remember")!;
    await def.execute("call-1", { scope: "task", note: "watch out for this" });
    expect(await repo.getPersonaMemory("reviewer", task.id)).toBe("- watch out for this");
  });

  it("memory_remember errors when scope is unavailable on this run", async () => {
    const r = makeRegistrar();
    const run = await makeRun();
    await personaMemoryFactory(persona, run, CWD)(r.reg);
    const def = r.tools.get("memory_remember")!;
    const result = await def.execute("call-1", { scope: "task", note: "x" });
    expect(result.isError).toBe(true);
  });

  it("memory_forget removes matching lines and reports count", async () => {
    await repo.appendPersonaMemory("reviewer", "global", "alpha");
    await repo.appendPersonaMemory("reviewer", "global", "beta");
    const r = makeRegistrar();
    const run = await makeRun();
    await personaMemoryFactory(persona, run, CWD)(r.reg);
    const result = await r.tools.get("memory_forget")!.execute("call-1", {
      scope: "global", match: "alpha",
    });
    expect((result.content[0] as any).text).toContain("Removed 1");
    expect(await repo.getPersonaMemory("reviewer", "global")).toBe("- beta");
  });
});
