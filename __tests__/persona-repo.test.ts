import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { personas as personasTable, personaMemories } from "../db/schema";
import * as repo from "../lib/repo";

function clear() {
  db.delete(personaMemories).run();
  db.delete(personasTable).run();
}

function seedReviewer() {
  db.insert(personasTable).values({
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews PRs",
    systemPrompt: "You review code.",
    modelProvider: "anthropic",
    modelId: "claude-opus-4-5",
    thinkingLevel: "high",
    toolsProfile: "repo_read,gh_pr",
    skillPaths: "[]",
  }).run();
}

describe("persona repo", () => {
  beforeEach(clear);

  it("getPersona returns null for unknown id", () => {
    expect(repo.getPersona("nope")).toBeNull();
  });

  it("getPersona returns the row for a known id", () => {
    seedReviewer();
    const p = repo.getPersona("reviewer");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("reviewer");
    expect(p!.toolsProfile).toBe("repo_read,gh_pr");
  });

  it("listPersonaIds returns sorted ids", () => {
    seedReviewer();
    db.insert(personasTable).values({
      id: "implementor", name: "Implementor", systemPrompt: "x",
      modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
      toolsProfile: "orchestrator,repo_write",
    }).run();
    expect(repo.listPersonaIds()).toEqual(["implementor", "reviewer"]);
  });

  it("getPersonaMemory returns null when none exists", () => {
    seedReviewer();
    expect(repo.getPersonaMemory("reviewer", "global")).toBeNull();
  });

  it("appendPersonaMemory creates the row on first call", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "always check tests");
    const body = repo.getPersonaMemory("reviewer", "global");
    expect(body).toBe("- always check tests");
  });

  it("appendPersonaMemory appends a bullet to existing body", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "first");
    repo.appendPersonaMemory("reviewer", "global", "second");
    const body = repo.getPersonaMemory("reviewer", "global");
    expect(body).toBe("- first\n- second");
  });

  it("removePersonaMemoryLine removes lines containing the substring", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "alpha note");
    repo.appendPersonaMemory("reviewer", "global", "beta note");
    repo.appendPersonaMemory("reviewer", "global", "gamma note");
    const removed = repo.removePersonaMemoryLine("reviewer", "global", "beta");
    expect(removed).toBe(1);
    expect(repo.getPersonaMemory("reviewer", "global")).toBe("- alpha note\n- gamma note");
  });

  it("removePersonaMemoryLine returns 0 when no match", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "alpha");
    expect(repo.removePersonaMemoryLine("reviewer", "global", "zzz")).toBe(0);
  });

  it("memory scopes are independent", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "g");
    repo.appendPersonaMemory("reviewer", "task-1", "t");
    expect(repo.getPersonaMemory("reviewer", "global")).toBe("- g");
    expect(repo.getPersonaMemory("reviewer", "task-1")).toBe("- t");
  });

  it("upsertPersona inserts then updates by id", () => {
    repo.upsertPersona({
      id: "qa", name: "QA", systemPrompt: "test things",
      modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
      toolsProfile: "repo_read", skillPaths: [],
    });
    expect(repo.getPersona("qa")!.systemPrompt).toBe("test things");
    repo.upsertPersona({
      id: "qa", name: "QA", systemPrompt: "test all the things",
      modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
      toolsProfile: "repo_read", skillPaths: [],
    });
    expect(repo.getPersona("qa")!.systemPrompt).toBe("test all the things");
  });
});
