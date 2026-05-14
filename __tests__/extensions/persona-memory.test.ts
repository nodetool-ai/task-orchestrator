import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { personaMemoryFactory } from "../../lib/extensions/persona-memory";
import { db } from "../../db";
import { personas as personasTable, personaMemories } from "../../db/schema";
import * as repo from "../../lib/repo";
import type { Persona } from "../../lib/personas/types";

const persona: Persona = {
  id: "reviewer", name: "Reviewer", description: "",
  systemPrompt: "review code",
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  toolsProfile: "repo_read", skillPaths: [],
};

function makeStub() {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const pi: any = {
    on: (e: string, h: Function) => handlers.set(e, h),
    registerTool: (def: any) => tools.set(def.name, def),
  };
  return { handlers, tools, pi };
}

describe("personaMemoryFactory", () => {
  let cwd: string;

  beforeEach(async () => {
    db.delete(personaMemories).run();
    db.delete(personasTable).run();
    db.insert(personasTable).values({
      id: "reviewer", name: "Reviewer", systemPrompt: "x",
      modelProvider: "anthropic", modelId: "claude-opus-4-5",
      toolsProfile: "repo_read",
    }).run();
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "persona-mem-"));
  });

  it("writes a SKILL.md with empty body when no memory exists", async () => {
    const { handlers, pi } = makeStub();
    const run: any = { taskId: null, repoId: null };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    await handlers.get("before_agent_start")!({}, {});
    const skill = await fs.readFile(
      path.join(cwd, ".pi", "skills", "persona-memory-reviewer", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: persona-memory-reviewer");
    expect(skill).toContain("description:");
  });

  it("writes a SKILL.md including bullets from each scope that has body", async () => {
    repo.appendPersonaMemory("reviewer", "global", "always check tests");
    repo.appendPersonaMemory("reviewer", "repo-1", "this repo uses vitest");
    const { handlers, pi } = makeStub();
    const run: any = { taskId: null, repoId: "repo-1" };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    await handlers.get("before_agent_start")!({}, {});
    const skill = await fs.readFile(
      path.join(cwd, ".pi", "skills", "persona-memory-reviewer", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("always check tests");
    expect(skill).toContain("this repo uses vitest");
  });

  it("registers memory_remember and memory_forget tools", () => {
    const { tools, pi } = makeStub();
    const run: any = { taskId: "t-1", repoId: "r-1" };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    expect(tools.has("memory_remember")).toBe(true);
    expect(tools.has("memory_forget")).toBe(true);
  });

  it("memory_remember at task scope persists to the task scope key", async () => {
    const { tools, pi } = makeStub();
    const run: any = { taskId: "T-1", repoId: "R-1" };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    const def = tools.get("memory_remember")!;
    await def.execute("call-1", { scope: "task", note: "watch out for this" });
    expect(repo.getPersonaMemory("reviewer", "T-1")).toBe("- watch out for this");
  });

  it("memory_remember errors when scope is unavailable on this run", async () => {
    const { tools, pi } = makeStub();
    const run: any = { taskId: null, repoId: null };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    const def = tools.get("memory_remember")!;
    const result = await def.execute("call-1", { scope: "task", note: "x" });
    expect(result.isError).toBe(true);
  });

  it("memory_forget removes matching lines and reports count", async () => {
    repo.appendPersonaMemory("reviewer", "global", "alpha");
    repo.appendPersonaMemory("reviewer", "global", "beta");
    const { tools, pi } = makeStub();
    const run: any = { taskId: null, repoId: null };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    const result = await tools.get("memory_forget")!.execute("call-1", {
      scope: "global", match: "alpha",
    });
    expect(result.content[0].text).toContain("Removed 1");
    expect(repo.getPersonaMemory("reviewer", "global")).toBe("- beta");
  });
});
