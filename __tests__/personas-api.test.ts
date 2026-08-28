import { describe, expect, it, beforeEach } from "vitest";
import { NextRequest } from "next/server";
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
    const res = await GET(new NextRequest("http://localhost/api/personas"));
    const body = await res.json();
    expect(body.personas.length).toBe(7);
    const r = body.personas.find((p: any) => p.id === "implementor");
    expect(r).toMatchObject({ id: "implementor", name: "Implementor" });
    expect(typeof r.systemPrompt).toBe("string");
    expect(typeof r.toolsProfile).toBe("string");
    // A persona carries no engine (migration 0031) — model, backend and
    // reasoning level are per-run.
    expect(r).not.toHaveProperty("modelProvider");
    expect(r).not.toHaveProperty("modelId");
    expect(r).not.toHaveProperty("backend");
    expect(r).not.toHaveProperty("thinkingLevel");
  });
});
