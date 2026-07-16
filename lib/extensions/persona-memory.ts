// lib/extensions/persona-memory.ts
//
// Shared memory: cross-session notes scoped to (global, repo, task). Renders
// the relevant scopes into an ambient skill the backend exposes to the model
// (pi: a SKILL.md in .pi/skills/; Claude: appended to the system prompt). Tools
// memory_search / memory_remember / memory_forget query and mutate the store.
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
import { legacyToolInvoker } from "./legacy-invoker";
import type { ExtensionFactory, ToolInvoker } from "./types";

export const MEMORY_SYSTEM_GUIDANCE = `Memory:
- You can read and write shared long-term memory with memory_search and memory_remember.
- Search memory before answering when the request may depend on prior user preferences, durable decisions, repo conventions, task history, or facts learned in earlier chats/runs.
- Write memory only for durable information that is likely to matter later. Do not store secrets, credentials, transient status, or obvious facts already captured in tasks/plans.
- When writing memory, choose the narrowest useful scope: task for task-specific facts, repo for repository conventions, global for user/workspace preferences. Include 3-8 concise keywords that should retrieve it later.`;

interface RunLite {
  id: number;
  taskId: string | null;
  repoId: string | null;
}

function memorySkillDescription(personaName: string): string {
  return `Shared cross-session memory available to ${personaName} for this workspace, repo, and task.`;
}

function renderMemoryBody(
  personaName: string,
  blocks: Array<{ scope: string; body: string; keywords?: string[] }>
): string {
  if (blocks.length === 0) {
    return `# Shared memory for ${personaName}\n\n(no notes yet)`;
  }
  const body = blocks.map((b) => {
    const keywords = b.keywords && b.keywords.length > 0
      ? `\n\nKeywords: ${b.keywords.join(", ")}`
      : "";
    return `## ${b.scope}\n\n${b.body}${keywords}`;
  }).join("\n\n");
  return `# Shared memory for ${personaName}\n\n${body}`;
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
}): Promise<{ personaId: string; repoId: string | null; taskId: string | null; runId: number } | null> {
  if (typeof ctx.runId !== "number" || ctx.runId <= 0) return null;
  const runs = await import("../runs");
  const run = await runs.get(ctx.runId);
  if (!run) return null;
  return {
    personaId: run.personaId ?? "implementor",
    repoId: run.repoId,
    taskId: run.taskId,
    runId: run.id,
  };
}

function scopeSpecs(mc: { repoId: string | null; taskId: string | null }) {
  return [
    { scope: "global" as const, scopeKey: null },
    ...(mc.repoId ? [{ scope: "repo" as const, scopeKey: mc.repoId }] : []),
    ...(mc.taskId ? [{ scope: "task" as const, scopeKey: mc.taskId }] : []),
  ];
}

function parseKeywords(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string")
      : [];
  } catch {
    return [];
  }
}

function memoryScopeKey(
  scope: string,
  mc: { repoId: string | null; taskId: string | null }
): { scope: "global" | "repo" | "task"; scopeKey: string | null } | null {
  if (scope === "global") return { scope: "global", scopeKey: null };
  if (scope === "repo" && mc.repoId) return { scope: "repo", scopeKey: mc.repoId };
  if (scope === "task" && mc.taskId) return { scope: "task", scopeKey: mc.taskId };
  return null;
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
      const blocks: Array<{ scope: string; body: string; keywords?: string[] }> = [];
      const recent = await repo.listRecentMemories({ scopes: scopeSpecs(mc), limit: 12 });
      for (const m of recent) {
        const label = m.scope === "global" ? "global" : `${m.scope}:${m.scopeKey}`;
        blocks.push({ scope: label, body: m.body, keywords: parseKeywords(m.keywords) });
      }
      // Back-compat: surface existing persona_memories rows until deployments
      // have migrated their useful notes into shared memories.
      const legacyScopeKeys = ["global", mc.repoId, mc.taskId].filter(
        (s): s is string => typeof s === "string" && s.length > 0
      );
      for (const s of legacyScopeKeys) {
        const body = await repo.getPersonaMemory(mc.personaId, s);
        if (body && body.trim().length > 0) {
          blocks.push({ scope: `legacy:${s}`, body });
        }
      }
      return ok(JSON.stringify({ blocks }));
    },
  },

  {
    name: "memory_search",
    label: "Search Memory",
    description:
      "Search shared memory with BM25 over the current global, repo, and task scopes. Use before relying on prior preferences, decisions, conventions, or task/repo history.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
    }),
    execute: async ({ query, limit }: { query: string; limit?: number }, ctx) => {
      const mc = await memoryContext(ctx);
      if (!mc) return errResult("memory_search needs a run context.");
      const results = await repo.searchMemories({
        query,
        scopes: scopeSpecs(mc),
        limit: limit ?? 8,
      });
      return ok(JSON.stringify({
        results: results.map((r) => ({
          id: r.memory.id,
          scope: r.memory.scope,
          scopeKey: r.memory.scopeKey,
          body: r.memory.body,
          keywords: parseKeywords(r.memory.keywords),
          score: Number(r.score.toFixed(4)),
          updatedAt: r.memory.updatedAt.toISOString(),
        })),
      }));
    },
  },

  {
    name: "memory_remember",
    label: "Remember",
    description:
      "Persist a durable shared memory at one of three scopes (global / repo / task). Include concise keywords that should retrieve it later.",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("global"), Type.Literal("repo"), Type.Literal("task")]),
      note: Type.String({ minLength: 1 }),
      keywords: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    execute: async ({ scope, note, keywords }: { scope: string; note: string; keywords?: string[] }, ctx) => {
      const mc = await memoryContext(ctx);
      if (!mc) return errResult("memory_remember needs a run context.");
      const target = memoryScopeKey(scope, mc);
      if (!target) {
        return errResult(`No ${scope} scope on this run; cannot remember at that scope.`);
      }
      await repo.createMemory({
        scope: target.scope,
        scopeKey: target.scopeKey,
        body: note,
        keywords,
        createdByRunId: mc.runId,
        author: "agent",
      });
      // Preserve legacy persona memory behavior for older UI/tests.
      const legacyScopeKey = scope === "global" ? "global" : target.scopeKey;
      if (legacyScopeKey) await repo.appendPersonaMemory(mc.personaId, legacyScopeKey, note);
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
      const target = memoryScopeKey(scope, mc);
      if (!target) {
        return errResult(`No such scope on this run.`);
      }
      const removed = await repo.removeMemoriesBySubstring({
        scopes: [target],
        match,
      });
      let legacyRemoved = 0;
      const legacyScopeKey = scope === "global" ? "global" : target.scopeKey;
      if (legacyScopeKey) {
        legacyRemoved = await repo.removePersonaMemoryLine(mc.personaId, legacyScopeKey, match);
      }
      return ok(`Removed ${Math.max(removed, legacyRemoved)} entry/entries.`);
    },
  },
];

/** The agent-facing subset (memory__load stays internal). */
const AGENT_MEMORY_TOOLS = MEMORY_TOOLS.filter((t) => t.name !== "memory__load");

// ────────────────────────────────────────
// Extension factory (transport-backed wrappers)
// ────────────────────────────────────────

export const personaMemoryFactory =
  (persona: Persona, run: RunLite, _cwd: string, invoke?: ToolInvoker): ExtensionFactory =>
  async (reg) => {
    const callTool = invoke ?? legacyToolInvoker(run.id, { author: "agent" });

    // Compose the memory guidance into the system prompt via the extension seam.
    // Before R3 the lightweight loop hardcoded `persona.systemPrompt + MEMORY_
    // SYSTEM_GUIDANCE` while the full-SDK path never surfaced the guidance at all;
    // routing it through here makes every backend (pi session, Claude, and the
    // postgres/lightweight loop) carry the same instructions for the memory tools
    // this factory also registers.
    reg.transformSystemPrompt((base) =>
      base.length > 0 ? `${base}\n\n${MEMORY_SYSTEM_GUIDANCE}` : MEMORY_SYSTEM_GUIDANCE
    );

    // Ambient skill: the persona's memory blocks, loaded server-side. A load
    // failure must not break the mount — the agent just starts without the
    // ambient notes (and can still read/write via the tools).
    let blocks: Array<{ scope: string; body: string; keywords?: string[] }> = [];
    try {
      const r = await callTool("memory__load", {});
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
          const r = await callTool(tool.name, params);
          return { content: r.content, details: undefined, isError: r.isError ?? false };
        },
      });
    }
  };
