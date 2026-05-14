// lib/extensions/persona-prompt.ts
//
// Inject the persona's system prompt at turn start. Replaces the Claude SDK's
// `systemPrompt: { preset: "claude_code" }` option, which we lose by leaving
// that SDK. Pi's before_agent_start handler returns { systemPrompt } to set
// the system prompt for the turn; we prepend the persona prompt to whatever
// pi already assembled.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "./types";
import type { Persona } from "@/lib/personas/types";

export const personaPromptFactory =
  (persona: Persona): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event: any) => {
      const base = event.systemPrompt ?? "";
      const next = base.length > 0
        ? `${persona.systemPrompt}\n\n${base}`
        : persona.systemPrompt;
      return { systemPrompt: next };
    });
  };
