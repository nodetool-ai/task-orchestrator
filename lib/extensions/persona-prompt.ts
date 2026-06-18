// lib/extensions/persona-prompt.ts
//
// Inject the persona's system prompt at turn start. The backend's system-prompt
// transform receives whatever base prompt the SDK assembled; we prepend the
// persona prompt to it. (On pi this maps to before_agent_start; on Claude it is
// appended to the claude_code preset.)

import type { ExtensionFactory } from "./types";
import type { Persona } from "@/lib/personas/types";

export const personaPromptFactory =
  (persona: Persona): ExtensionFactory =>
  (reg) => {
    reg.transformSystemPrompt((base) => {
      return base.length > 0
        ? `${persona.systemPrompt}\n\n${base}`
        : persona.systemPrompt;
    });
  };
