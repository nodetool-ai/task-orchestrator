import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { listPersonaIds, getPersona } from "../lib/repo";

describe("seedPersonas", () => {
  beforeEach(async () => {
    await db.delete(personasTable);
  });

  it("inserts all personas on first call", async () => {
    await seedPersonas();
    expect((await listPersonaIds()).sort()).toEqual(
      ["designer", "executor", "implementor", "planner", "planning-agent", "qa", "reviewer"]
    );
  });

  it("is idempotent — second call is a no-op semantically", async () => {
    await seedPersonas();
    await seedPersonas();
    expect(await listPersonaIds()).toHaveLength(7);
  });

  it("does NOT overwrite a UI-edited persona on subsequent seeds", async () => {
    await seedPersonas();
    await db.update(personasTable)
      .set({ systemPrompt: "stale" })
      .where(eq(personasTable.id, "reviewer"));
    await seedPersonas();
    const r = (await getPersona("reviewer"))!;
    expect(r.systemPrompt).toBe("stale");
  });

  it("force: true upserts existing rows from the TS definition", async () => {
    await seedPersonas();
    await db.update(personasTable)
      .set({ systemPrompt: "stale" })
      .where(eq(personasTable.id, "reviewer"));
    await seedPersonas({ force: true });
    const r = (await getPersona("reviewer"))!;
    expect(r.systemPrompt).toContain("code reviewer");
  });

  it("reviewer persona has expected shape", async () => {
    await seedPersonas();
    const r = (await getPersona("reviewer"))!;
    expect(r.toolsProfile).toContain("gh_pr");
  });
});
