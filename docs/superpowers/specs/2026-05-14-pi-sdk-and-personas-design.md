# Pi SDK migration + Agent Personas — Design

**Date:** 2026-05-14
**Status:** Approved for implementation
**Scope:** Single PR. Replaces `@anthropic-ai/claude-agent-sdk` with
`@earendil-works/pi-coding-agent`, and introduces a persona model that
binds system prompt, model, tools, skills, memory, and budget defaults
to a named role.

## Motivation

- **Vendor diversification.** Today the runner is hard-wired to one
  agent runtime. Pi exposes the same agent capabilities with multi-provider
  model support and a richer extension model.
- **Per-job model/provider routing.** Different task types want different
  models — reviewer wants high-thinking Opus, implementor wants fast
  Sonnet, planner may want a different provider entirely. The current
  `agent_sessions.model` column is per-run; we want a config bundle
  attached to a role.
- **Composable agent configuration.** A persona binds (system prompt,
  model, tools profile, skills, memory, budgets). Today each of these is
  a freeform per-run field with no shared default.

## Non-goals

- Cross-SDK abstraction layer. We are doing a hard cutover; no adapter,
  no feature flag, `@anthropic-ai/claude-agent-sdk` is removed in this PR.
- USD budget enforcement. Pi does not surface `total_cost_usd`. The
  `budgetMaxUsd` column stays for historical data but is no longer
  consulted by `checkBudget()`.
- Backwards compatibility for existing in-flight runs. The cutover
  drains in-flight runs to terminal state; resuming a run that started
  on the Claude SDK is out of scope (the `sdk_session_id` field is
  reused for a different purpose post-cutover).

## Background — current state

`lib/runs.ts:runOneTurn()` (lines ~970–1074) is the single ingress to
the agent runtime:

```ts
const sdk = await import("@anthropic-ai/claude-agent-sdk");
const { servers } = await resolveProfiles(run.toolsProfile, profileCtx);
const stream = sdk.query({
  prompt,
  options: {
    cwd, permissionMode: "bypassPermissions",
    model: run.model ?? DEFAULT_MODEL,
    env, abortController: abort,
    systemPrompt: { type: "preset", preset: "claude_code" },
    mcpServers: servers,
    resume: run.sdkSessionId ?? undefined,
    sandbox: SANDBOX_OPTS,
  },
});
for await (const m of stream) { /* persist + bus */ }
```

Four in-process MCP servers are built with `createSdkMcpServer/tool`:
`lib/gh-pr-mcp.ts`, `lib/gh-ci-mcp.ts`, `lib/spawn-mcp.ts`,
`lib/agent-mcp.ts`. Always-on filesystem sandbox is enforced by the
SDK itself (commit `a431a3d`). Resume by `sdkSessionId`. Cost and token
totals come from the `result` envelope.

## Background — pi.dev capabilities

- **Sessions** — `createAgentSession({ cwd, model, authStorage,
  modelRegistry, sessionManager, resourceLoader })`, then
  `session.prompt()` and `session.subscribe(event => …)`.
- **SessionManager** — `SessionManager.create(cwd, sessionDir)` for new,
  `.open(path, sessionDir)` to resume. Sessions persist as JSONL trees
  in `~/.pi/agent/sessions/` by default; we override to a project-local
  directory.
- **Extensions** — TypeScript modules registered via
  `DefaultResourceLoader({ extensionFactories })`. Each extension gets
  an `ExtensionAPI` (`pi`) with:
  - `pi.registerTool({ name, description, parameters: TypeBox, execute })`
  - `pi.on(event, handler)` — full lifecycle: `before_agent_start`,
    `agent_start`, `agent_end`, `turn_start`, `turn_end`,
    `message_start`, `message_update`, `message_end`,
    `tool_execution_{start,update,end}`, `tool_call`, `tool_result`,
    `before_provider_request`, `after_provider_response`,
    `model_select`, `thinking_level_select`, `session_*`, `input`, etc.
  - `pi.registerProvider`, `pi.setModel`, `pi.exec`, `pi.events`
- **Skills** — `SKILL.md` directories auto-discovered from
  `.pi/skills/`, `~/.pi/agent/skills/`, npm package `skills/` dirs, or
  explicit settings/CLI paths. Frontmatter has `description` (drives
  model-driven activation), `allowed-tools` (experimental tool gating).
- **Tool gating** — `tool_call` hook can `return { block: true,
  reason }` to deny a call, or mutate `event.input` to patch arguments.
- **Providers** — `getModel(provider, modelId)` returns a model handle.
  `AuthStorage` reads keys from `~/.pi/agent/auth.json` or
  `ANTHROPIC_API_KEY` etc.

**Gaps vs. Claude SDK:**

1. No built-in filesystem sandbox.
2. No `total_cost_usd` field.
3. No `claude_code` system-prompt preset.
4. No cross-session persona memory.

Each gap is closed by code in this design.

## Architecture

```
package.json                        − @anthropic-ai/claude-agent-sdk
                                     + @earendil-works/pi-coding-agent
                                     + typebox

db/migrations/0010_personas.sql     NEW — personas, persona_memories tables;
                                          agent_sessions.persona_id FK
db/seed-personas.ts                 NEW — upserts personas from lib/personas/*

lib/personas/
  types.ts                          NEW — Persona type, helpers
  reviewer.ts | implementor.ts |    NEW — one file per persona
  planner.ts  | designer.ts | qa.ts
  skills/                           NEW — bundled SKILL.md dirs per persona

lib/extensions/                     REPLACES lib/*-mcp.ts
  gh-pr.ts, gh-ci.ts, spawn.ts, agent.ts
  sandbox.ts                        NEW — tool_call fs sandbox
  persona-prompt.ts                 NEW — before_agent_start system prompt
  persona-memory.ts                 NEW — memory_remember/forget tools +
                                          before_agent_start memory skill
  abort-bridge.ts                   NEW — AbortController → ctx.abort()

lib/runs.ts                         REWRITTEN runOneTurn() against pi
lib/pi-event-mapper.ts              NEW — pi events → existing RunEnvelope
lib/profiles.ts                     resolveProfiles → ExtensionFactory[]
```

`runOneTurn()` remains the single ingress. Everything downstream
(`persistMessage`, the run-bus SSE source, criteria gating, UI) is
unchanged because we map pi events back to the existing internal
envelope shape at the boundary.

## Schema

```sql
CREATE TABLE personas (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  system_prompt   TEXT NOT NULL,
  model_provider  TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  thinking_level  TEXT,                       -- 'low'|'medium'|'high'|NULL
  tools_profile   TEXT NOT NULL,              -- composed profile keys
  skill_paths     TEXT NOT NULL DEFAULT '[]', -- JSON array of repo-relative paths
  budget_max_turns    INTEGER,
  budget_max_seconds  INTEGER,
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE persona_memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,                  -- 'global' | <repo_id> | <task_id>
  body        TEXT NOT NULL,                  -- markdown bullets
  updated_at  INTEGER,
  UNIQUE(persona_id, scope)
);

ALTER TABLE agent_sessions ADD COLUMN persona_id TEXT REFERENCES personas(id);
```

`agent_sessions.sdk_session_id` is **repurposed** post-cutover to hold
the absolute path to the pi JSONL session file. The column is not
renamed (avoids cascading code changes); its semantics are documented
in `SCHEMA.md` and a code comment near the column definition.

`agent_sessions.model` and `agent_sessions.tools_profile` stay as
per-run overrides on top of the persona's defaults. Resolution at
`runOneTurn` start: `effective = run.field ?? persona.field`.

## Persona definition (TypeScript-seeded)

```ts
// lib/personas/types.ts
export interface Persona {
  id: string;                                   // 'reviewer','implementor',...
  name: string;                                 // display
  description: string;
  systemPrompt: string;
  model: { provider: string; id: string };
  thinkingLevel?: "low" | "medium" | "high";
  toolsProfile: string;                         // e.g. "repo_read,gh_pr"
  skillPaths: string[];                         // repo-root-relative
  budget?: { maxTurns?: number; maxSeconds?: number };
}

// lib/personas/reviewer.ts
import type { Persona } from "./types";
export const reviewer: Persona = {
  id: "reviewer",
  name: "Reviewer",
  description: "Reviews PRs and proposes change requests",
  systemPrompt: `You review code changes...`,
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  thinkingLevel: "high",
  toolsProfile: "repo_read,gh_pr,gh_ci",
  skillPaths: ["lib/personas/skills/code-review"],
  budget: { maxTurns: 20 },
};
```

`lib/personas/index.ts` exports the array `[reviewer, implementor,
planner, designer, qa]`. `db/seed-personas.ts` upserts each row by id
on every boot, called from `instrumentation.ts` next to user seeding.
Editing a persona means editing the TS file; the change is picked up
on next boot.

## runOneTurn (the new core)

```ts
async function runOneTurn(args: RunOneTurnArgs): Promise<TurnResult> {
  const { run, cwd, prompt, abort, author, onSdk } = args;
  const persona = repo.getPersona(run.personaId ?? "implementor");

  const modelId = run.model ?? persona.model.id;
  const profile = run.toolsProfile ?? persona.toolsProfile;
  const profileCtx: ProfileContext = {
    runId: run.id, run, author, taskId: run.taskId, cwd,
  };

  const factories: ExtensionFactory[] = [
    personaPromptFactory(persona),
    personaMemoryFactory(persona, run, repo, cwd),
    sandboxFactory(cwd, sandboxDbPathFor(run, cwd)),
    abortBridgeFactory(abort),
    ...resolveProfiles(profile, profileCtx),       // returns ExtensionFactory[]
  ];

  const sessionDir = sessionDirFor(cwd);
  const sessionManager = run.sdkSessionId
    ? SessionManager.open(run.sdkSessionId, sessionDir)
    : SessionManager.create(cwd, sessionDir);

  const authStorage = AuthStorage.create();
  const { session } = await createAgentSession({
    cwd,
    model: getModel(persona.model.provider, modelId),
    thinkingLevel: persona.thinkingLevel,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage),
    sessionManager,
    resourceLoader: new DefaultResourceLoader({
      extensionFactories: factories,
      additionalSkillPaths: persona.skillPaths.map((p) =>
        path.resolve(cwd, p)
      ),
    }),
  });

  const envelopes: RunEnvelope[] = [];
  const result = newTurnAccumulator();

  const stop = session.subscribe((ev) => {
    for (const env of mapPiEvent(ev, session, sessionManager)) {
      envelopes.push(env);
      onSdk?.(env);
      accumulate(result, env);
      persistEnvelopeIfNeeded(run.id, env);
    }
  });

  await session.prompt(prompt);
  await waitForAgentEnd(session);
  stop();

  if (!run.sdkSessionId) {
    db.update(agentSessions)
      .set({ sdkSessionId: sessionManager.getSessionFile()! })
      .where(eq(agentSessions.id, run.id))
      .run();
  }

  return finalize(result, envelopes);
}
```

`waitForAgentEnd(session)` is a small helper that resolves on the next
`agent_end` event (via the same subscribe channel) — pi's `prompt()`
returns before the turn completes.

## Extensions

### Tool/MCP translation pattern

Each `lib/*-mcp.ts` becomes an `lib/extensions/*.ts` factory. Mechanical
translation:

```ts
// BEFORE
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
return createSdkMcpServer({
  name: "gh_pr",
  tools: [
    tool({
      name: "pr_view",
      inputSchema: z.object({ number: z.number() }),
      handler: async (input) => ({ content: [...] }),
    }),
  ],
});

// AFTER — lib/extensions/gh-pr.ts
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export const ghPrExtension =
  (ctx: ProfileContext): ExtensionFactory => (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "gh_pr__pr_view",                  // flat namespace → manual prefix
      description: "...",
      parameters: Type.Object({ number: Type.Number() }),
      execute: async (_id, params) => ({ content: [...], details: {...} }),
    });
  };
```

Schema translation is mechanical: `z.object → Type.Object`, `z.string()
→ Type.String()`, `z.number().int()` → `Type.Integer()`, `z.optional →
Type.Optional`, `z.enum(...)` → `StringEnum([...] as const)`. Throws are
preserved as-is — pi treats thrown errors as tool errors.

**Naming convention for the flat namespace:** `<profileKey>__<toolName>`,
e.g. `gh_pr__pr_view`, `spawn__spawn_agent`. The `__` separator is
unique enough for log-grep and unlikely to collide with built-ins.

### Sandbox extension

```ts
// lib/extensions/sandbox.ts
import path from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const sandboxFactory =
  (cwd: string, sandboxDbPath: string): ExtensionFactory => (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName === "write" || event.toolName === "edit") {
        const target = event.input?.path;
        if (typeof target !== "string") return;
        const abs = path.resolve(cwd, target);
        if (!abs.startsWith(cwd + path.sep) && abs !== cwd) {
          return { block: true, reason: `Write outside ${cwd} denied` };
        }
      }
      if (event.toolName === "bash" && typeof event.input?.command === "string") {
        // Inject sandboxed DB path so subprocesses don't touch the host data.db
        event.input.command =
          `export TASK_ORCH_DB=${shellEscape(sandboxDbPath)}\n` +
          event.input.command;
      }
    });
  };
```

This reproduces today's two invariants from `SANDBOX_OPTS`:
writes/edits confined to `cwd`; bash subprocesses see the run-scoped
`TASK_ORCH_DB`. The sandbox extension is **always** appended to the
factory list, regardless of profile.

### Persona-prompt extension

```ts
// lib/extensions/persona-prompt.ts
export const personaPromptFactory =
  (persona: Persona): ExtensionFactory => (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptPrefix = persona.systemPrompt;
    });
  };
```

Replaces today's `systemPrompt: { preset: "claude_code" }`. The preset
is not ported — its content was generic Claude coding conventions that
the model already follows.

### Persona-memory extension

```ts
// lib/extensions/persona-memory.ts
export const personaMemoryFactory =
  (persona: Persona, run: RunRow, repo: Repo, cwd: string): ExtensionFactory =>
  (pi: ExtensionAPI) => {

    pi.on("before_agent_start", async () => {
      const scopes = ["global", run.repoId, run.taskId].filter(Boolean) as string[];
      const memos = scopes.map((s) => ({
        scope: s,
        body: repo.getPersonaMemory(persona.id, s) ?? "",
      })).filter((m) => m.body.trim().length > 0);

      const skillDir = path.join(cwd, ".pi", "skills", `persona-memory-${persona.id}`);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        renderMemorySkill(persona, memos),
      );
    });

    pi.registerTool({
      name: "memory_remember",
      description: "Persist a note to this persona's memory.",
      parameters: Type.Object({
        scope: StringEnum(["global", "repo", "task"] as const),
        note: Type.String(),
      }),
      execute: async (_id, { scope, note }) => {
        const scopeKey = scope === "global" ? "global"
                       : scope === "repo"   ? run.repoId
                       :                       run.taskId;
        if (!scopeKey) {
          return { content: [{ type: "text", text: `No ${scope} scope on this run.` }],
                   isError: true };
        }
        repo.appendPersonaMemory(persona.id, scopeKey, note);
        return { content: [{ type: "text", text: `Remembered (${scope}).` }] };
      },
    });

    pi.registerTool({
      name: "memory_forget",
      description: "Remove a memory line by substring match.",
      parameters: Type.Object({
        scope: Type.String(),
        match: Type.String(),
      }),
      execute: async (_id, { scope, match }) => {
        const removed = repo.removePersonaMemoryLine(persona.id, scope, match);
        return { content: [{ type: "text", text: `Removed ${removed} entry/entries.` }] };
      },
    });
  };
```

`renderMemorySkill` produces a SKILL.md with frontmatter
(`description: "Memory accrued by the <persona> persona"`) and a body
that lists each scope's bullets under its own heading. Pi's
progressive-disclosure skill model means the model sees the
description always, loads the body when relevant.

`repo.appendPersonaMemory` does read-modify-write of the row body (one
line appended). `repo.removePersonaMemoryLine` removes any line
containing the substring; returns count removed.

### Abort-bridge extension

```ts
// lib/extensions/abort-bridge.ts
export const abortBridgeFactory =
  (abort: AbortController): ExtensionFactory => (pi: ExtensionAPI) => {
    pi.on("agent_start", (_ev, ctx) => {
      const onAbort = () => { try { ctx.abort(); } catch {} };
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
```

## Sub-run dispatch (spawn extension)

The spawn tool's parameter schema grows a required `persona: string`:

```ts
pi.registerTool({
  name: "spawn__spawn_agent",
  parameters: Type.Object({
    goal: Type.String(),
    persona: Type.String(),                    // NEW, required
    toolsProfile: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    budgetMaxTurns: Type.Optional(Type.Integer()),
    // ...
  }),
  execute: async (_id, { goal, persona, ...rest }) => {
    const p = repo.getPersona(persona);
    if (!p) {
      return {
        content: [{ type: "text",
          text: `Unknown persona '${persona}'. Valid: ${repo.listPersonaIds().join(", ")}` }],
        isError: true,
      };
    }
    const child = repo.createAgentSession({
      taskId: parentRun.taskId, personaId: persona, goal, ...rest,
    });
    return { content: [{ type: "text", text: `Spawned ${child.id}` }],
             details: { runId: child.id } };
  },
});
```

No persona inference, no defaulting from parent. Explicit makes the
parent's intent reviewable in logs.

## Event mapping

`lib/pi-event-mapper.ts` translates pi events to the existing internal
envelope (renamed `SdkMessageEnvelope → RunEnvelope` for clarity but
shape-compatible):

| Pi event                 | RunEnvelope                                                    |
|--------------------------|----------------------------------------------------------------|
| `agent_start`            | `{ type: "system", subtype: "init", session_id: <file path> }` |
| `message_end {message}`  | `{ type: "assistant", message: { content: [...blocks] } }`     |
| `tool_execution_end`     | `{ type: "user", message: { content: [{ type:"tool_result"}] } }` |
| `agent_end {messages}`   | `{ type: "result", result: <last text>, usage: {input, output}, total_cost_usd: null }` |
| `text_delta` / `thinking_delta` | Forwarded raw to bus for streaming; not persisted (matches today) |

The `session_id` field on the `init` envelope is repurposed to carry
the JSONL file path — that path is what we now use to resume.
Downstream code that does `if (m.session_id) db.update(...sdkSessionId)`
keeps working unchanged.

## Profile resolution

`lib/profiles.ts` (today returns `{ servers: McpServers }`) becomes:

```ts
export interface ProfileResolution {
  extensionFactories: ExtensionFactory[];
}
export async function resolveProfiles(
  profileSpec: string,
  ctx: ProfileContext,
): Promise<ExtensionFactory[]>;
```

Per-profile activation logic (same as today) emits factories for the
listed profiles. Sandbox + persona-prompt + persona-memory +
abort-bridge are appended by `runOneTurn`, not by `resolveProfiles`.

## Budgets

- `budgetMaxTurns` — count `turn_end` events. Default from
  `persona.budget.maxTurns`; per-run override stays in
  `agent_sessions.budget_max_turns`.
- `budgetMaxSeconds` — turn-start clock check, unchanged. Default from
  `persona.budget.maxSeconds`.
- `budgetMaxUsd` — column kept for historical data. `checkBudget()`
  drops the USD branch. Note added to `SCHEMA.md`.

`agent_sessions.total_cost_usd` is set to `NULL` on every new pi run.

## UI changes

- **Task create form / chat composer:** add a persona dropdown
  (`select` populated from `GET /api/personas`). Default = `implementor`.
- **Run detail page:** show persona name + model in the header.
- **Persona admin (read-only):** new `/personas` page listing the seeded
  personas with their system prompts, models, tools, skills, budgets.
  Editing is out of scope this PR — edit the TS file.

## Rollout

Hard cutover, single PR. Commits ordered for reviewability:

1. `db/migrations/0010_personas.sql` + `db/schema.ts` updates +
   `db/seed-personas.ts`. No behavior change yet.
2. `lib/personas/*.ts` files (5 personas + types + index + bundled
   skill dirs).
3. `lib/extensions/*.ts` ports of the four MCP servers + sandbox +
   persona-prompt + persona-memory + abort-bridge. Still unused.
4. `lib/profiles.ts` switched to factory output. Compile-only change
   that will break `runs.ts` until step 5.
5. `lib/pi-event-mapper.ts` + `runOneTurn` rewrite + dep swap in
   `package.json`. Removes Claude SDK import.
6. UI: persona picker + read-only `/personas` page.
7. Tests + a manual smoke run.

No feature flag — vendor diversification means committing to pi as
primary on merge.

## Testing

- **Unit (vitest):**
  - Each `lib/extensions/*.ts` registers expected tool names against a
    stub `ExtensionAPI`; each tool's `execute` returns the expected
    shape on canned inputs.
  - `sandbox.ts`: matrix of (toolName, input) → block/allow/mutate.
  - `persona-memory.ts`: `before_agent_start` writes a SKILL.md with
    the right frontmatter + body for given memory rows; `remember`
    appends, `forget` removes by substring.
  - `pi-event-mapper.ts`: canned pi event sequences map to expected
    envelope sequences (snapshot tests).
  - `db/seed-personas.ts`: idempotent across reboots; updating a TS
    file then re-seeding updates the row.
- **Integration:**
  - `agent_sessions.persona_id` round-trips; per-run `model` /
    `tools_profile` overrides win over persona defaults.
- **Manual E2E:**
  - One reviewer run on a small PR → reaches `completed`, posts a
    review comment.
  - One implementor run on a throwaway task → reaches `completed`,
    opens a PR.
  - `memory_remember` from one run is visible in the next run's mounted
    SKILL.md.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Pi `SessionManager` file format changes upstream | Pin the dep version. Sessions are JSONL; we only read `getSessionFile()`. |
| `tool_call` hook semantics change (return shape for `block`) | Pin dep. Cover with sandbox unit tests so a regression fails CI. |
| Pi's flat tool namespace collides with a built-in | Use `<profile>__` prefix. Reserve a one-line check at registration time that warns on collision. |
| `claude_code` preset removal regresses behavior on existing tasks | Persona system prompts can grow to absorb anything we miss. Not blocking. |
| Memory file written into `cwd/.pi/skills/` is a write inside the worktree | That's intentional — the worktree GC already cleans `.pi/`. Add `.pi/` to the worktree's gitignore so memory files don't leak into commits. |
| Spawned sub-run uses an unknown persona id | Spawn tool returns an error listing valid ids; parent retries. |

## Open questions

None.
