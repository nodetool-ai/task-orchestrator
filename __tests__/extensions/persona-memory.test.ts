import { describe, expect, it, beforeEach } from "vitest";
import { personaMemoryFactory } from "../../lib/extensions/persona-memory";
import { db } from "../../db";
import { personas as personasTable, personaMemories } from "../../db/schema";
import * as repo from "../../lib/repo";
import type { Persona } from "../../lib/personas/types";
import { makeRegistrar } from "../helpers/fake-registrar";

const persona: Persona = {
  id: "reviewer", name: "Reviewer", description: "",
  systemPrompt: "review code",
  toolsProfile: "repo_read"
};

const CWD = "/tmp/persona-mem-test";

describe("personaMemoryFactory", () => {
  beforeEach(async () => {
    await db.delete(personaMemories);
    await db.delete(personasTable);
    await db.insert(personasTable).values({
      id: "reviewer", name: "Reviewer", systemPrompt: "x",
      toolsProfile: "repo_read",
    });
  });

  it("adds an ambient skill with empty body when no memory exists", async () => {
    const r = makeRegistrar();
    const run: any = { taskId: null, repoId: null };
    await personaMemoryFactory(persona, run, repo, CWD)(r.reg);
    expect(r.skills.length).toBe(1);
    expect(r.skills[0].name).toBe("persona-memory-reviewer");
    expect(r.skills[0].description).toContain("Reviewer");
    expect(r.skills[0].body).toContain("(no notes yet)");
  });

  it("adds an ambient skill including bullets from each scope that has body", async () => {
    await repo.appendPersonaMemory("reviewer", "global", "always check tests");
    await repo.appendPersonaMemory("reviewer", "repo-1", "this repo uses vitest");
    const r = makeRegistrar();
    const run: any = { taskId: null, repoId: "repo-1" };
    await personaMemoryFactory(persona, run, repo, CWD)(r.reg);
    expect(r.skills[0].body).toContain("always check tests");
    expect(r.skills[0].body).toContain("this repo uses vitest");
  });

  it("registers memory_remember and memory_forget tools", async () => {
    const r = makeRegistrar();
    const run: any = { taskId: "t-1", repoId: "r-1" };
    await personaMemoryFactory(persona, run, repo, CWD)(r.reg);
    expect(r.tools.has("memory_remember")).toBe(true);
    expect(r.tools.has("memory_forget")).toBe(true);
  });

  it("memory_remember at task scope persists to the task scope key", async () => {
    const r = makeRegistrar();
    const run: any = { taskId: "T-1", repoId: "R-1" };
    await personaMemoryFactory(persona, run, repo, CWD)(r.reg);
    const def = r.tools.get("memory_remember")!;
    await def.execute("call-1", { scope: "task", note: "watch out for this" });
    expect(await repo.getPersonaMemory("reviewer", "T-1")).toBe("- watch out for this");
  });

  it("memory_remember errors when scope is unavailable on this run", async () => {
    const r = makeRegistrar();
    const run: any = { taskId: null, repoId: null };
    await personaMemoryFactory(persona, run, repo, CWD)(r.reg);
    const def = r.tools.get("memory_remember")!;
    const result = await def.execute("call-1", { scope: "task", note: "x" });
    expect(result.isError).toBe(true);
  });

  it("memory_forget removes matching lines and reports count", async () => {
    await repo.appendPersonaMemory("reviewer", "global", "alpha");
    await repo.appendPersonaMemory("reviewer", "global", "beta");
    const r = makeRegistrar();
    const run: any = { taskId: null, repoId: null };
    await personaMemoryFactory(persona, run, repo, CWD)(r.reg);
    const result = await r.tools.get("memory_forget")!.execute("call-1", {
      scope: "global", match: "alpha",
    });
    expect((result.content[0] as any).text).toContain("Removed 1");
    expect(await repo.getPersonaMemory("reviewer", "global")).toBe("- beta");
  });
});
