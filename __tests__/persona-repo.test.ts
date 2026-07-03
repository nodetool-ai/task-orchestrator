import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { personas as personasTable, personaMemories } from "../db/schema";
import * as repo from "../lib/repo";

async function clear() {
  await db.delete(personaMemories);
  await db.delete(personasTable);
}

async function seedReviewer() {
  await db.insert(personasTable).values({
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews PRs",
    systemPrompt: "You review code.",    thinkingLevel: "high",
    toolsProfile: "repo_read,gh_pr",
    skillPaths: "[]",
  });
}

describe("persona repo", () => {
  beforeEach(clear);

  it("getPersona returns null for unknown id", async () => {
    expect(await repo.getPersona("nope")).toBeNull();
  });

  it("getPersona returns the row for a known id", async () => {
    await seedReviewer();
    const p = await repo.getPersona("reviewer");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("reviewer");
    expect(p!.toolsProfile).toBe("repo_read,gh_pr");
  });

  it("listPersonaIds returns sorted ids", async () => {
    await seedReviewer();
    await db.insert(personasTable).values({
      id: "implementor", name: "Implementor", systemPrompt: "x",
           toolsProfile: "orchestrator,repo_write",
    });
    expect(await repo.listPersonaIds()).toEqual(["implementor", "reviewer"]);
  });

  it("getPersonaMemory returns null when none exists", async () => {
    await seedReviewer();
    expect(await repo.getPersonaMemory("reviewer", "global")).toBeNull();
  });

  it("appendPersonaMemory creates the row on first call", async () => {
    await seedReviewer();
    await repo.appendPersonaMemory("reviewer", "global", "always check tests");
    const body = await repo.getPersonaMemory("reviewer", "global");
    expect(body).toBe("- always check tests");
  });

  it("appendPersonaMemory appends a bullet to existing body", async () => {
    await seedReviewer();
    await repo.appendPersonaMemory("reviewer", "global", "first");
    await repo.appendPersonaMemory("reviewer", "global", "second");
    const body = await repo.getPersonaMemory("reviewer", "global");
    expect(body).toBe("- first\n- second");
  });

  it("removePersonaMemoryLine removes lines containing the substring", async () => {
    await seedReviewer();
    await repo.appendPersonaMemory("reviewer", "global", "alpha note");
    await repo.appendPersonaMemory("reviewer", "global", "beta note");
    await repo.appendPersonaMemory("reviewer", "global", "gamma note");
    const removed = await repo.removePersonaMemoryLine("reviewer", "global", "beta");
    expect(removed).toBe(1);
    expect(await repo.getPersonaMemory("reviewer", "global")).toBe("- alpha note\n- gamma note");
  });

  it("removePersonaMemoryLine returns 0 when no match", async () => {
    await seedReviewer();
    await repo.appendPersonaMemory("reviewer", "global", "alpha");
    expect(await repo.removePersonaMemoryLine("reviewer", "global", "zzz")).toBe(0);
  });

  it("memory scopes are independent", async () => {
    await seedReviewer();
    await repo.appendPersonaMemory("reviewer", "global", "g");
    await repo.appendPersonaMemory("reviewer", "task-1", "t");
    expect(await repo.getPersonaMemory("reviewer", "global")).toBe("- g");
    expect(await repo.getPersonaMemory("reviewer", "task-1")).toBe("- t");
  });

  it("removePersonaMemoryLine deletes the row when all lines match", async () => {
    await seedReviewer();
    await repo.appendPersonaMemory("reviewer", "global", "alpha");
    await repo.appendPersonaMemory("reviewer", "global", "alphabet");  // both match 'alpha'
    const removed = await repo.removePersonaMemoryLine("reviewer", "global", "alpha");
    expect(removed).toBe(2);
    expect(await repo.getPersonaMemory("reviewer", "global")).toBeNull();
  });

  it("appendPersonaMemory after a clearing remove starts fresh (no leading newline)", async () => {
    await seedReviewer();
    await repo.appendPersonaMemory("reviewer", "global", "alpha");
    await repo.removePersonaMemoryLine("reviewer", "global", "alpha");
    await repo.appendPersonaMemory("reviewer", "global", "beta");
    expect(await repo.getPersonaMemory("reviewer", "global")).toBe("- beta");
  });

  it("upsertPersona inserts then updates by id", async () => {
    await repo.upsertPersona({
      id: "qa", name: "QA", systemPrompt: "test things",
           toolsProfile: "repo_read", skillPaths: [],
    });
    expect((await repo.getPersona("qa"))!.systemPrompt).toBe("test things");
    await repo.upsertPersona({
      id: "qa", name: "QA", systemPrompt: "test all the things",
           toolsProfile: "repo_read", skillPaths: [],
    });
    expect((await repo.getPersona("qa"))!.systemPrompt).toBe("test all the things");
  });
});
