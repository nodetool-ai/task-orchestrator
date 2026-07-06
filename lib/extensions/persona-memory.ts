// lib/extensions/persona-memory.ts
//
// Persona memory: cross-session notes scoped to (global, repo, task). Renders
// the relevant scopes into an ambient skill the backend exposes to the model
// (pi: a SKILL.md in .pi/skills/; Claude: appended to the system prompt). Tools
// memory_remember / memory_forget mutate the store.
//
// EXECUTION MODEL: the tool bodies live in MEMORY_TOOLS (server-executable
// registry entries, resolved by lib/worker/server-tools) and derive the
// persona + scopes from the caller's run row server-side — workers hold no
// database access. The ambient memory text is loaded through the same channel
// (the internal memory__load tool) at mount time.

import { Type } from "typebox";
import * as repo from "../repo";
import type { Persona } from "@/lib/personas/types";
import type { OrchestratorTool, OrchestratorToolResult } from "../orchestrator-tools";
import { runTransport } from "@/lib/worker";
import type { ExtensionFactory } from "./types";

interface RunLite {
  id: number;
  taskId: string | null;
  repoId: string | null;
}

function memorySkillDescription(personaName: string): string {
  return `Cross-session notes the ${personaName} persona has written about itself, the current repo, and the current task.`;
}

function renderMemoryBody(
  personaName: string,
  blocks: Array<{ scope: string; body: string }>
): string {
  if (blocks.length === 0) {
    return `# ${personaName} memory\n\n(no notes yet)`;
  }
  const body = blocks.map((b) => `## ${b.scope}\n\n${b.body}`).join("\n\n");
  return `# ${personaName} memory\n\n${body}`;
}

const ok = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
});
const errResult = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/** Server-side: the caller run's persona id + memory scope keys. */
async function memoryContext(ctx: {
  runId?: number;
}): Promise<{ personaId: string; repoId: string | null; taskId: string | null } | null> {
  if (typeof ctx.runId !== "number" || ctx.runId <= 0) return null;
  const runs = await import("../runs");
  const run = await runs.get(ctx.runId);
  if (!run) return null;
  return {
    personaId: run.personaId ?? "implementor",
    repoId: run.repoId,
    taskId: run.taskId,
  };
}

// ────────────────────────────────────────
// Server-executable tool registry
// ────────────────────────────────────────

export const MEMORY_TOOLS: OrchestratorTool[] = [
  {
    // Internal: the mount-time ambient-skill read. Registered in the server
    // registry (so the factory can fetch memory over the transport) but NOT
    // registered as an agent-facing tool.
    name: "memory__load",
    label: "Load Persona Memory",
    description: "Internal: load the caller persona's memory blocks for the ambient skill.",
    parameters: Type.Object({}),
    execute: async (_params, ctx) => {
      const mc = await memoryContext(ctx);
      if (!mc) return errResult("memory__load needs a run context.");
      const scopeKeys = ["global", mc.repoId, mc.taskId].filter(
        (s): s is string => typeof s === "string" && s.length > 0
      );
      const blocks: Array<{ scope: string; body: string }> = [];
      for (const s of scopeKeys) {
        const body = await repo.getPersonaMemory(mc.personaId, s);
        if (body && body.trim().length > 0) blocks.push({ scope: s, body });
      }
      return ok(JSON.stringify({ blocks }));
    },
  },

  {
    name: "memory_remember",
    label: "Remember",
    description:
      "Persist a note to this persona's memory at one of three scopes (global / repo / task).",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("global"), Type.Literal("repo"), Type.Literal("task")]),
      note: Type.String({ minLength: 1 }),
    }),
    execute: async ({ scope, note }: { scope: string; note: string }, ctx) => {
      const mc = await memoryContext(ctx);
      if (!mc) return errResult("memory_remember needs a run context.");
      const scopeKey =
        scope === "global" ? "global" : scope === "repo" ? mc.repoId : mc.taskId;
      if (!scopeKey) {
        return errResult(`No ${scope} scope on this run; cannot remember at that scope.`);
      }
      await repo.appendPersonaMemory(mc.personaId, scopeKey, note);
      return ok(`Remembered (${scope}).`);
    },
  },

  {
    name: "memory_forget",
    label: "Forget",
    description: "Remove memory lines containing the given substring within a scope.",
    parameters: Type.Object({
      scope: Type.String({ minLength: 1 }),
      match: Type.String({ minLength: 1 }),
    }),
    execute: async ({ scope, match }: { scope: string; match: string }, ctx) => {
      const mc = await memoryContext(ctx);
      if (!mc) return errResult("memory_forget needs a run context.");
      const scopeKey =
        scope === "global" ? "global" :
        scope === "repo"   ? mc.repoId :
        scope === "task"   ? mc.taskId :
                             scope;
      if (!scopeKey) {
        return errResult(`No such scope on this run.`);
      }
      const removed = await repo.removePersonaMemoryLine(mc.personaId, scopeKey, match);
      return ok(`Removed ${removed} entry/entries.`);
    },
  },
];

/** The agent-facing subset (memory__load stays internal). */
const AGENT_MEMORY_TOOLS = MEMORY_TOOLS.filter((t) => t.name !== "memory__load");

// ────────────────────────────────────────
// Extension factory (transport-backed wrappers)
// ────────────────────────────────────────

export const personaMemoryFactory =
  (persona: Persona, run: RunLite, _cwd: string): ExtensionFactory =>
  async (reg) => {
    const transport = await runTransport();

    // Ambient skill: the persona's memory blocks, loaded server-side. A load
    // failure must not break the mount — the agent just starts without the
    // ambient notes (and can still read/write via the tools).
    let blocks: Array<{ scope: string; body: string }> = [];
    try {
      const r = await transport.callTool(run.id, "memory__load", {}, { author: "agent" });
      const text = r.content.find((c) => c.type === "text");
      if (!r.isError && text && text.type === "text") {
        blocks = (JSON.parse(text.text) as { blocks: typeof blocks }).blocks ?? [];
      }
    } catch {
      // start without ambient memory
    }
    reg.addAmbientSkill({
      name: `persona-memory-${persona.id}`,
      description: memorySkillDescription(persona.name),
      body: renderMemoryBody(persona.name, blocks),
    });

    for (const tool of AGENT_MEMORY_TOOLS) {
      reg.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_id: string, params: unknown) => {
          const r = await transport.callTool(run.id, tool.name, params, { author: "agent" });
          return { content: r.content, details: undefined, isError: r.isError ?? false };
        },
      });
    }
  };
