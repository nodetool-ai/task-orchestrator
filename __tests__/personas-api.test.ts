import { describe, expect, it, beforeEach } from "vitest";
import { GET } from "../app/api/personas/route";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";

describe("GET /api/personas", () => {
  beforeEach(async () => {
    await db.delete(personasTable);
    await seedPersonas();
  });

  it("returns all seeded personas with the expected shape", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.personas.length).toBe(6);
    const r = body.personas.find((p: any) => p.id === "implementor");
    expect(r).toMatchObject({ id: "implementor", name: "Implementor" });
    expect(r.modelProvider).toBe("anthropic");
    expect(typeof r.modelId).toBe("string");
    expect(typeof r.systemPrompt).toBe("string");
    expect(typeof r.toolsProfile).toBe("string");
  });
});
