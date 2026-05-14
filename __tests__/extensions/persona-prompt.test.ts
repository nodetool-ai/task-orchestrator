import { describe, expect, it } from "vitest";
import { personaPromptFactory } from "../../lib/extensions/persona-prompt";
import type { Persona } from "../../lib/personas/types";

const persona: Persona = {
  id: "x", name: "X", description: "", systemPrompt: "YOU ARE X.",
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  toolsProfile: ""
};

function makeStub() {
  const handlers = new Map<string, Function>();
  const pi: any = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerTool: () => {},
  };
  return { handlers, pi };
}

describe("personaPromptFactory", () => {
  it("returns a systemPrompt that prepends the persona prompt to pi's default", async () => {
    const { handlers, pi } = makeStub();
    personaPromptFactory(persona)(pi);
    const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "DEFAULT BASE PROMPT" };
    const result = await handlers.get("before_agent_start")!(event, {});
    expect(result).toEqual({
      systemPrompt: "YOU ARE X.\n\nDEFAULT BASE PROMPT",
    });
  });

  it("handles an empty default systemPrompt", async () => {
    const { handlers, pi } = makeStub();
    personaPromptFactory(persona)(pi);
    const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "" };
    const result = await handlers.get("before_agent_start")!(event, {});
    expect(result).toEqual({
      systemPrompt: "YOU ARE X.",
    });
  });
});
