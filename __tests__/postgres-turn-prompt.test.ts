// R3: the lightweight (postgres-mode) turn's system prompt must compose through
// the SAME extensions the full-SDK path uses — personaPromptFactory contributes
// the persona prompt, personaMemoryFactory the memory guidance — instead of the
// old hardcoded `persona.systemPrompt + MEMORY_SYSTEM_GUIDANCE`. This pins that
// the composition (which lib/agent-backend/postgres-turn.ts feeds to pi-ai as the
// Context.systemPrompt) still carries both pieces.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import { collectExtensions, composeSystemPrompt } from "../lib/agent-backend/collect";
import { personaPromptFactory } from "../lib/extensions/persona-prompt";
import { personaMemoryFactory, MEMORY_SYSTEM_GUIDANCE } from "../lib/extensions/persona-memory";
import type { Extension } from "../lib/agent-backend/types";

const PERSONA_PROMPT = "You are the test implementor persona.";

beforeEach(async () => {
  await db.delete(personasTable);
  await repo.upsertPersona({
    id: "implementor",
    name: "Implementor",
    description: null,
    systemPrompt: PERSONA_PROMPT,
    modelProvider: "anthropic",
    modelId: "claude-sonnet-4-6",
    thinkingLevel: null,
    toolsProfile: "orchestrator",
    skillPaths: [],
    backend: null,
    budgetMaxTurns: null,
    budgetMaxSeconds: null,
  });
});

/** Build the persona-side extensions the way runOneTurn does, then compose their
 *  system-prompt transforms exactly as the postgres-mode loop does. */
async function composedPromptFor(goal: "<chat>" | "<execute>"): Promise<string> {
  const planId =
    goal === "<execute>"
      ? (await repo.createPlan({ title: "Prompt Plan", date: "2026-07-02" })).id
      : undefined;
  const run = await runs.create({ goal, planId, defer: true } as any);
  const full = (await runs.get(run.id))!;
  const persona = {
    id: "implementor",
    name: "Implementor",
    description: "",
    systemPrompt: PERSONA_PROMPT,
    thinkingLevel: undefined,
    toolsProfile: "orchestrator",
    skillPaths: [] as string[],
  };
  const extensions: Extension[] = [
    personaPromptFactory(persona),
    personaMemoryFactory(persona, full, "/tmp"),
  ];
  const collected = await collectExtensions(extensions);
  return (await composeSystemPrompt("", collected.systemPromptFns)).trim();
}

describe("postgres-mode system prompt composition", () => {
  it("a lightweight chat's composed prompt carries the persona prompt and memory guidance", async () => {
    const composed = await composedPromptFor("<chat>");
    expect(composed).toContain(PERSONA_PROMPT);
    expect(composed).toContain(MEMORY_SYSTEM_GUIDANCE);
  });

  it("a lightweight executor's composed prompt carries the persona prompt and memory guidance", async () => {
    const composed = await composedPromptFor("<execute>");
    expect(composed).toContain(PERSONA_PROMPT);
    expect(composed).toContain(MEMORY_SYSTEM_GUIDANCE);
  });
});
