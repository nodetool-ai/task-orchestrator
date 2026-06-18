// lib/extensions/persona-memory.ts
//
// Persona memory: cross-session notes scoped to (global, repo, task). Renders
// the relevant scopes into an ambient skill the backend exposes to the model
// (pi: a SKILL.md in .pi/skills/; Claude: appended to the system prompt). Tools
// memory_remember / memory_forget mutate the DB.

import { Type } from "typebox";
import type { Persona } from "@/lib/personas/types";
import type { ExtensionFactory } from "./types";

interface RunLite {
  taskId: string | null;
  repoId: string | null;
}

interface MemoryRepo {
  getPersonaMemory: (personaId: string, scope: string) => string | null;
  appendPersonaMemory: (personaId: string, scope: string, note: string) => void;
  removePersonaMemoryLine: (personaId: string, scope: string, match: string) => number;
}

function memorySkillDescription(persona: Persona): string {
  return `Cross-session notes the ${persona.name} persona has written about itself, the current repo, and the current task.`;
}

function renderMemoryBody(
  persona: Persona,
  blocks: Array<{ scope: string; body: string }>
): string {
  if (blocks.length === 0) {
    return `# ${persona.name} memory\n\n(no notes yet)`;
  }
  const body = blocks.map((b) => `## ${b.scope}\n\n${b.body}`).join("\n\n");
  return `# ${persona.name} memory\n\n${body}`;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const errResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });

export const personaMemoryFactory =
  (persona: Persona, run: RunLite, repo: MemoryRepo, _cwd: string): ExtensionFactory =>
  (reg) => {
    const scopeKeys = ["global", run.repoId, run.taskId].filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    const blocks: Array<{ scope: string; body: string }> = [];
    for (const s of scopeKeys) {
      const body = repo.getPersonaMemory(persona.id, s);
      if (body && body.trim().length > 0) blocks.push({ scope: s, body });
    }
    reg.addAmbientSkill({
      name: `persona-memory-${persona.id}`,
      description: memorySkillDescription(persona),
      body: renderMemoryBody(persona, blocks),
    });

    reg.registerTool({
      name: "memory_remember",
      label: "Remember",
      description: "Persist a note to this persona's memory at one of three scopes (global / repo / task).",
      parameters: Type.Object({
        scope: Type.Union([
          Type.Literal("global"),
          Type.Literal("repo"),
          Type.Literal("task"),
        ]),
        note: Type.String({ minLength: 1 }),
      }),
      execute: async (_id: string, { scope, note }: { scope: string; note: string }) => {
        const scopeKey =
          scope === "global" ? "global" :
          scope === "repo"   ? run.repoId :
                               run.taskId;
        if (!scopeKey) {
          return errResult(`No ${scope} scope on this run; cannot remember at that scope.`);
        }
        repo.appendPersonaMemory(persona.id, scopeKey, note);
        return ok(`Remembered (${scope}).`);
      },
    });

    reg.registerTool({
      name: "memory_forget",
      label: "Forget",
      description: "Remove memory lines containing the given substring within a scope.",
      parameters: Type.Object({
        scope: Type.String({ minLength: 1 }),
        match: Type.String({ minLength: 1 }),
      }),
      execute: async (_id: string, { scope, match }: { scope: string; match: string }) => {
        const scopeKey =
          scope === "global" ? "global" :
          scope === "repo"   ? run.repoId :
          scope === "task"   ? run.taskId :
                               scope;
        if (!scopeKey) {
          return errResult(`No such scope on this run.`);
        }
        const removed = repo.removePersonaMemoryLine(persona.id, scopeKey, match);
        return ok(`Removed ${removed} entry/entries.`);
      },
    });
  };
