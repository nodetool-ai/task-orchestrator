// A persona is WHO an agent is, not WHICH engine runs it (migration 0031).
// model / backend / thinkingLevel are per-run choices with the deployment
// defaults behind them; the persona row has no say and no columns for them.
//
// The gap this closes: the concierge used to pin backend='pi' with an Anthropic
// model, so prod run 190 died with "No API key found for anthropic" on a host
// authenticated for the Claude backend. A wrong engine pin was invisible until
// a turn failed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
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
    toolsProfile: "orchestrator",
    skillPaths: [],
    budgetMaxTurns: null,
    budgetMaxSeconds: null,
  });
});

describe("a persona carries no engine", () => {
  it("has no model, backend or reasoning column to carry one", async () => {
    const persona = (await repo.getPersona("implementor"))!;
    expect(persona).not.toHaveProperty("modelProvider");
    expect(persona).not.toHaveProperty("modelId");
    expect(persona).not.toHaveProperty("backend");
    expect(persona).not.toHaveProperty("thinkingLevel");
  });

  it("a run with no pick lands on the deployment defaults", async () => {
    const run = await runs.create({ goal: "<implement>", defer: true });
    expect(run.model).toBe("anthropic/claude-opus-4-8");
    expect(run.backend).toBe("pi");
  });

  it("a per-run pick decides the engine", async () => {
    const run = await runs.create({
      goal: "<implement>",
      model: "anthropic/claude-sonnet-5",
      backend: "claude",
      thinkingLevel: "high",
      defer: true,
    });
    expect(run.model).toBe("anthropic/claude-sonnet-5");
    expect(run.backend).toBe("claude");
    expect(run.thinkingLevel).toBe("high");
  });

  it("takes a codex pick with an OpenAI model", async () => {
    const run = await runs.create({
      goal: "<implement>",
      model: "openai/gpt-5.6-terra",
      backend: "codex",
      defer: true,
    });
    expect(run.backend).toBe("codex");
    expect(run.model).toBe("openai/gpt-5.6-terra");
  });

  // The one engine rule create() still enforces: the single-vendor backends can
  // only speak to their own provider, so those pairs can never run and must fail
  // at create time rather than dying on the run's first turn.
  it("still rejects the claude backend with a non-Anthropic model", async () => {
    await expect(
      runs.create({ goal: "<implement>", model: "openai/gpt-5", backend: "claude", defer: true })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects the codex backend with a non-OpenAI model", async () => {
    await expect(
      runs.create({
        goal: "<implement>",
        model: "anthropic/claude-sonnet-5",
        backend: "codex",
        defer: true,
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});
