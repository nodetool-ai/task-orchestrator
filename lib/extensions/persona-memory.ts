// lib/extensions/persona-memory.ts
//
// Shared memory: cross-session notes scoped to (global, repo, task, persona,
// user) — repo.MEMORY_SCOPES is the source of truth for the set. Renders
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
- When writing memory, choose the narrowest useful scope and include 3-8 concise keywords that should retrieve it later:
  - user: durable facts about the person you are talking to — their preferences, timezone/working hours, projects they own, how they like to be answered, standing instructions they gave you.
  - persona: your OWN working style and standing decisions — conventions you adopted, judgment calls you keep making the same way, operating preferences you learned about how to do your job well.
  - task: facts specific to the current task.
  - repo: repository conventions.
  - global: workspace-wide preferences that apply to everyone.
- Prefer user/persona over global for anything that is about one person or about how you personally operate — global is shared by every persona and every user.`;

interface RunLite {
  id: number;
  taskId: string | null;
  repoId: string | null;
}

/** The run fields the memory scopes derive from (design §4). */
export interface MemoryScopeRun {
  id: number;
  personaId?: string | null;
  repoId: string | null;
  taskId: string | null;
  userId?: number | null;
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

interface MemoryContext {
  personaId: string;
  repoId: string | null;
  taskId: string | null;
  userId: number | null;
  runId: number;
}

/** Derive the memory context from a run row (no DB round-trip). */
function memoryContextFromRun(run: MemoryScopeRun): MemoryContext {
  return {
    personaId: run.personaId ?? "implementor",
    repoId: run.repoId,
    taskId: run.taskId,
    userId: run.userId ?? null,
    runId: run.id,
  };
}

/** Server-side: the caller run's persona id + memory scope keys. */
async function memoryContext(ctx: { runId?: number }): Promise<MemoryContext | null> {
  if (typeof ctx.runId !== "number" || ctx.runId <= 0) return null;
  const runs = await import("../runs");
  const run = await runs.get(ctx.runId);
  if (!run) return null;
  return memoryContextFromRun(run);
}

type ScopeSpec = { scope: repo.MemoryScope; scopeKey: string | null };
type MemoryRow = Awaited<ReturnType<typeof repo.listRecentMemories>>[number];

/**
 * Every memory scope this run can see (design §4): the workspace/repo/task
 * context it operates in, PLUS the persona doing the work and the user it works
 * for. A run always has a persona; user scope appears only once the run is
 * attributed to a real user (Discord `/link`, web session). user scope keys are
 * `String(users.id)`.
 */
function scopeSpecs(mc: {
  personaId?: string | null;
  repoId: string | null;
  taskId: string | null;
  userId?: number | null;
}): ScopeSpec[] {
  const personaId = mc.personaId ?? "implementor";
  return [
    { scope: "global", scopeKey: null },
    ...(mc.repoId ? [{ scope: "repo" as const, scopeKey: mc.repoId }] : []),
    ...(mc.taskId ? [{ scope: "task" as const, scopeKey: mc.taskId }] : []),
    ...(personaId ? [{ scope: "persona" as const, scopeKey: personaId }] : []),
    ...(mc.userId != null ? [{ scope: "user" as const, scopeKey: String(mc.userId) }] : []),
  ];
}

/**
 * Scopes that describe WHO is in the conversation (the persona and the user).
 * These get reserved slots in the ambient mount — see loadAmbientMemories.
 */
const IDENTITY_SCOPES: ReadonlySet<repo.MemoryScope> = new Set(["persona", "user"]);

/** Ambient mount budget: roughly the pre-M3 12-entry cap, split into groups. */
const AMBIENT_MEMORY_TOTAL = 14;
/** Slots the identity group (persona+user) always gets first, if it has rows. */
const AMBIENT_IDENTITY_RESERVED = 6;

/**
 * Load the ambient-mount memories with a PER-SCOPE-GROUP recency cap.
 *
 * A single recency query across all scopes lets a chatty repo/task push the
 * persona's and user's memories out of the mount entirely — the exact failure
 * the plan calls out ("user/persona memories always present"). So:
 *   1. identity (persona+user) takes up to AMBIENT_IDENTITY_RESERVED slots,
 *   2. context (global+repo+task) fills the remainder of AMBIENT_MEMORY_TOTAL,
 *   3. any capacity the context group did not use goes back to identity.
 * Step 3 keeps the mount at least as full as before when one group is empty.
 * The merged list is re-sorted by recency so the rendered order still reads
 * newest-first.
 */
async function loadAmbientMemories(mc: MemoryContext): Promise<MemoryRow[]> {
  const specs = scopeSpecs(mc);
  const identitySpecs = specs.filter((s) => IDENTITY_SCOPES.has(s.scope));
  const contextSpecs = specs.filter((s) => !IDENTITY_SCOPES.has(s.scope));
  const [identity, context] = await Promise.all([
    identitySpecs.length > 0
      ? repo.listRecentMemories({ scopes: identitySpecs, limit: AMBIENT_MEMORY_TOTAL })
      : Promise.resolve([]),
    contextSpecs.length > 0
      ? repo.listRecentMemories({ scopes: contextSpecs, limit: AMBIENT_MEMORY_TOTAL })
      : Promise.resolve([]),
  ]);
  const picked = identity.slice(0, AMBIENT_IDENTITY_RESERVED);
  picked.push(...context.slice(0, Math.max(0, AMBIENT_MEMORY_TOTAL - picked.length)));
  if (picked.length < AMBIENT_MEMORY_TOTAL) {
    picked.push(
      ...identity.slice(
        AMBIENT_IDENTITY_RESERVED,
        AMBIENT_IDENTITY_RESERVED + (AMBIENT_MEMORY_TOTAL - picked.length)
      )
    );
  }
  return picked.sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id
  );
}

function scopeLabel(m: { scope: string; scopeKey: string | null }): string {
  return m.scope === "global" ? "global" : `${m.scope}:${m.scopeKey}`;
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

/**
 * Resolve a model-supplied scope name against the scopes this run actually has.
 * repo.isMemoryScope is the vocabulary check (single source of truth); the
 * scopeSpecs list decides availability — asking for `user` on an unattributed
 * run is an error, not a silent global write.
 */
function memoryScopeKey(
  scope: string,
  mc: Parameters<typeof scopeSpecs>[0]
): ScopeSpec | null {
  if (!repo.isMemoryScope(scope)) return null;
  return scopeSpecs(mc).find((s) => s.scope === scope) ?? null;
}

/** Scopes whose notes are mirrored into the legacy persona_memories table. */
const LEGACY_MIRRORED_SCOPES: ReadonlySet<repo.MemoryScope> = new Set([
  "global",
  "repo",
  "task",
]);

/**
 * The legacy persona_memories key for a scope, or null when the scope has no
 * legacy equivalent. persona/user scopes are M3-new: memory__load only reads
 * legacy rows for global/repo/task, so mirroring them there would write rows
 * nothing ever reads.
 */
function legacyScopeKeyFor(target: ScopeSpec): string | null {
  if (!LEGACY_MIRRORED_SCOPES.has(target.scope)) return null;
  return target.scope === "global" ? "global" : target.scopeKey;
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
      const recent = await loadAmbientMemories(mc);
      for (const m of recent) {
        blocks.push({ scope: scopeLabel(m), body: m.body, keywords: parseKeywords(m.keywords) });
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
      "Search shared memory with BM25 over every scope visible to this run (global, repo, task, persona, user). Use before relying on prior preferences, decisions, conventions, or task/repo history.",
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
      `Persist a durable shared memory at one of the scopes visible to this run (${repo.MEMORY_SCOPES.join(" / ")}). ` +
      "Facts about the person you are talking to go to 'user'; your own working style and standing decisions go to 'persona'. " +
      "Include concise keywords that should retrieve it later.",
    parameters: Type.Object({
      // The scope vocabulary comes from repo.MEMORY_SCOPES so the tool schema
      // can never drift from what lib/repo.ts accepts.
      scope: Type.Union(repo.MEMORY_SCOPES.map((s) => Type.Literal(s))),
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
      // Preserve legacy persona memory behavior for older UI/tests (global /
      // repo / task only — see legacyScopeKeyFor).
      const legacyScopeKey = legacyScopeKeyFor(target);
      if (legacyScopeKey) await repo.appendPersonaMemory(mc.personaId, legacyScopeKey, note);
      return ok(`Remembered (${scope}).`);
    },
  },

  {
    name: "memory_forget",
    label: "Forget",
    description:
      `Remove memory lines containing the given substring within a scope (${repo.MEMORY_SCOPES.join(" / ")}).`,
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
      const legacyScopeKey = legacyScopeKeyFor(target);
      if (legacyScopeKey) {
        legacyRemoved = await repo.removePersonaMemoryLine(mc.personaId, legacyScopeKey, match);
      }
      return ok(`Removed ${Math.max(removed, legacyRemoved)} entry/entries.`);
    },
  },
];

// ────────────────────────────────────────
// Auto-recall: push memory into the turn's prompt
// ────────────────────────────────────────

/** How many search hits the injected block may carry. */
const INJECTED_MEMORY_LIMIT = 5;
/** Per-hit body budget so one long note can't dominate the turn's prompt. */
const INJECTED_BODY_CHARS = 400;

export const MEMORY_INJECTION_HEADING = "## Recalled memory (auto-search)";

/**
 * BM25-search every visible scope with the inbound user text and render the top
 * hits as a prompt block (design §4: memory is PUSHED into context, not just
 * available behind a tool). Returns null when there is nothing worth injecting.
 *
 * Cheap by construction: searchMemories is an in-process BM25 over DB rows —
 * no model call, no embedding service.
 *
 * NON-PERSISTENCE (critical): callers must weave the returned text into the
 * turn's PROMPT only — exactly like the inbox digest — and never persist it as
 * an agent_messages row. In postgres mode the context is rebuilt from
 * agent_messages every turn, so a persisted block would be re-fed to the model
 * on every subsequent turn; on the sdk-session path it would pollute the
 * transcript the same way. lib/runs.ts#runOneTurn is the single caller and
 * prepends this to `prompt` while leaving `rawUserText` (what gets persisted)
 * untouched.
 *
 * Hits already rendered into the ambient memory skill are dropped — the model
 * would otherwise see the same note twice in one request.
 */
export async function buildMemoryInjection(args: {
  run: MemoryScopeRun;
  text: string;
  limit?: number;
}): Promise<string | null> {
  const query = args.text.trim();
  if (!query) return null;
  const mc = memoryContextFromRun(args.run);
  const specs = scopeSpecs(mc);
  const limit = args.limit ?? INJECTED_MEMORY_LIMIT;

  const [hits, ambient] = await Promise.all([
    repo.searchMemories({ query, scopes: specs, limit: limit + AMBIENT_MEMORY_TOTAL }),
    loadAmbientMemories(mc),
  ]);
  if (hits.length === 0) return null;
  const ambientIds = new Set(ambient.map((m) => m.id));
  const fresh = hits.filter((h) => !ambientIds.has(h.memory.id)).slice(0, limit);
  if (fresh.length === 0) return null;

  const lines = fresh.map((h) => {
    const body = h.memory.body.length > INJECTED_BODY_CHARS
      ? `${h.memory.body.slice(0, INJECTED_BODY_CHARS)}…`
      : h.memory.body;
    return `- [${scopeLabel(h.memory)}] ${body.replace(/\n+/g, " ")}`;
  });
  return [
    MEMORY_INJECTION_HEADING,
    "",
    "Memory entries that matched this message. They may not all be relevant — use what applies, ignore the rest, and call memory_search for more.",
    "",
    ...lines,
  ].join("\n");
}

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
