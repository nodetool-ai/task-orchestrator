import { describe, expect, it, beforeEach } from "vitest";
import { GET } from "../app/api/personas/route";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";

describe("GET /api/personas", () => {
  beforeEach(() => {
    db.delete(personasTable).run();
    seedPersonas();
  });

  it("returns all seeded personas with the expected shape", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.personas.length).toBe(5);
    const r = body.personas.find((p: any) => p.id === "reviewer");
    expect(r).toMatchObject({
      id: "reviewer",
      name: "Reviewer",
      modelProvider: "anthropic",
      modelId: "claude-opus-4-5",
    });
    expect(Array.isArray(r.skillPaths)).toBe(true);
  });
});
