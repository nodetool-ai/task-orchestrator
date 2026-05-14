import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { listPersonaIds, getPersona } from "../lib/repo";

describe("seedPersonas", () => {
  beforeEach(() => {
    db.delete(personasTable).run();
  });

  it("inserts all five personas on first call", () => {
    seedPersonas();
    expect(listPersonaIds().sort()).toEqual(
      ["designer", "implementor", "planner", "qa", "reviewer"]
    );
  });

  it("is idempotent — second call is a no-op semantically", () => {
    seedPersonas();
    seedPersonas();
    expect(listPersonaIds()).toHaveLength(5);
  });

  it("does NOT overwrite a UI-edited persona on subsequent seeds", () => {
    seedPersonas();
    db.update(personasTable)
      .set({ systemPrompt: "stale" })
      .where(eq(personasTable.id, "reviewer"))
      .run();
    seedPersonas();
    const r = getPersona("reviewer")!;
    expect(r.systemPrompt).toBe("stale");
  });

  it("force: true upserts existing rows from the TS definition", () => {
    seedPersonas();
    db.update(personasTable)
      .set({ systemPrompt: "stale" })
      .where(eq(personasTable.id, "reviewer"))
      .run();
    seedPersonas({ force: true });
    const r = getPersona("reviewer")!;
    expect(r.systemPrompt).toContain("code reviewer");
  });

  it("reviewer persona has expected shape", () => {
    seedPersonas();
    const r = getPersona("reviewer")!;
    expect(r.modelProvider).toBeTruthy();
    expect(r.modelId).toBeTruthy();
    expect(r.toolsProfile).toContain("gh_pr");
  });
});
