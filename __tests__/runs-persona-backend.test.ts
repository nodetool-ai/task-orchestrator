// A persona can carry a default agent backend ("engine"); a run that doesn't
// pick one explicitly inherits it before falling back to the deployment
// default. Chat runs follow the same inheritance now that they execute in the
// full worker harness (no longer pinned to pi).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
import { eq } from "drizzle-orm";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";

const realCreate = runs.create;
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(runs, "create").mockImplementation((input) => realCreate({ ...input, defer: true }));
  await db.delete(personasTable);
  await repo.upsertPersona({
    id: "implementor",
    name: "Implementor",
    description: null,
    systemPrompt: "test",
    modelProvider: "anthropic",
    modelId: "claude-sonnet-4-6",
    thinkingLevel: null,
    toolsProfile: "orchestrator",
    skillPaths: [],
    backend: "claude",
    budgetMaxTurns: null,
    budgetMaxSeconds: null,
  });
});

describe("runs.create persona backend inheritance", () => {
  it("inherits the persona's backend when no per-run pick is given", async () => {
    const run = await runs.create({ goal: "<implement>", defer: true });
    expect(run.backend).toBe("claude");
  });

  it("a per-run backend pick overrides the persona default", async () => {
    const run = await runs.create({ goal: "<implement>", backend: "pi", defer: true });
    expect(run.backend).toBe("pi");
  });

  it("chat runs inherit the persona default backend (with a matching model)", async () => {
    const run = await runs.create({ goal: "<chat>", defer: true });
    expect(run.backend).toBe("claude");
  });

  it("rejects a persona default of claude with a non-Anthropic model", async () => {
    await db
      .update(personasTable)
      .set({ modelProvider: "openai", modelId: "gpt-5" })
      .where(eq(personasTable.id, "implementor"));
    await expect(runs.create({ goal: "<implement>", defer: true })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("a null persona backend persists the resolved deployment default", async () => {
    await db.update(personasTable).set({ backend: null }).where(eq(personasTable.id, "implementor"));
    const run = await runs.create({ goal: "<implement>", defer: true });
    expect(run.backend).toBe("pi");
  });
});
