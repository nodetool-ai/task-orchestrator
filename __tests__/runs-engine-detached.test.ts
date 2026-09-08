// Personas may pin a model for omitted per-run selections. Backend and
// thinkingLevel remain per-run choices with deployment defaults behind them.
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

describe("persona model pinning", () => {
  it("carries a nullable model but no backend or reasoning pin", async () => {
    const persona = (await repo.getPersona("implementor"))!;
    expect(persona.model).toBeNull();
    expect(persona).not.toHaveProperty("backend");
    expect(persona).not.toHaveProperty("thinkingLevel");
  });

  it("a run with no pick lands on the deployment defaults", async () => {
    const run = await runs.create({ goal: "<implement>", defer: true });
    expect(run.model).toBe("anthropic/claude-opus-4-8");
    expect(run.backend).toBe("pi");
  });

  it("uses the selected persona's model when a run omits one", async () => {
    await repo.upsertPersona({
      id: "implementor",
      name: "Implementor",
      description: null,
      systemPrompt: "test",
      toolsProfile: "orchestrator",
      model: "openai/gpt-5.6-terra",
      skillPaths: [],
    });
    const run = await runs.create({ goal: "<implement>", defer: true });
    expect(run.model).toBe("openai/gpt-5.6-terra");
  });

  it("lets an explicit run model override the persona pin", async () => {
    await repo.upsertPersona({
      id: "implementor",
      name: "Implementor",
      description: null,
      systemPrompt: "test",
      toolsProfile: "orchestrator",
      model: "openai/gpt-5.6-terra",
      skillPaths: [],
    });
    const run = await runs.create({
      goal: "<implement>",
      model: "anthropic/claude-sonnet-5",
      defer: true,
    });
    expect(run.model).toBe("anthropic/claude-sonnet-5");
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
