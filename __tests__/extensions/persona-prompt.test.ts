import { describe, expect, it } from "vitest";
import { personaPromptFactory } from "../../lib/extensions/persona-prompt";
import type { Persona } from "../../lib/personas/types";
import { makeRegistrar } from "../helpers/fake-registrar";

const persona: Persona = {
  id: "x", name: "X", description: "", systemPrompt: "YOU ARE X.",
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  toolsProfile: ""
};

describe("personaPromptFactory", () => {
  it("prepends the persona prompt to the backend's base prompt", async () => {
    const r = makeRegistrar();
    personaPromptFactory(persona)(r.reg);
    expect(await r.composePrompt("DEFAULT BASE PROMPT")).toBe("YOU ARE X.\n\nDEFAULT BASE PROMPT");
  });

  it("handles an empty base prompt", async () => {
    const r = makeRegistrar();
    personaPromptFactory(persona)(r.reg);
    expect(await r.composePrompt("")).toBe("YOU ARE X.");
  });
});
