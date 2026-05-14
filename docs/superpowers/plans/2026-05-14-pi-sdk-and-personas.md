# Pi SDK migration + Agent Personas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@anthropic-ai/claude-agent-sdk` with `@earendil-works/pi-coding-agent`, and ship an agent-persona model that bundles (system prompt, model, tools, skills, memory, budgets) per role.

**Architecture:** Hard cutover. `runOneTurn` in `lib/runs.ts` becomes the single ingress to the pi SDK. The four in-process MCP servers (`gh-pr`, `gh-ci`, `spawn`, `agent`) are ported to pi extensions; new extensions add a `tool_call` filesystem sandbox, a `before_agent_start` system-prompt injector, a per-persona memory layer (memory.md skill + remember/forget tools), and an abort bridge. Personas live as TS files under `lib/personas/` and seed into a new `personas` table on boot. Pi events are translated back to today's internal `SdkMessageEnvelope` shape so persistence, the SSE bus, and the UI stay untouched.

**Tech Stack:** TypeScript, Next.js 15, React 19, Drizzle ORM (SQLite/`better-sqlite3`), Vitest, `@earendil-works/pi-coding-agent`, `typebox`. Existing: `lib/runs.ts`, `lib/repo.ts`, `db/schema.ts`, `db/migrations/`.

**Source spec:** `docs/superpowers/specs/2026-05-14-pi-sdk-and-personas-design.md`

---

## File map

**Created:**
- `db/migrations/0010_personas.sql`
- `db/seed-personas.ts`
- `lib/personas/types.ts`, `index.ts`, `reviewer.ts`, `implementor.ts`, `planner.ts`, `designer.ts`, `qa.ts`
- `lib/personas/skills/code-review/SKILL.md` (+ similar empty-but-frontmattered skill dirs per persona)
- `lib/extensions/types.ts`
- `lib/extensions/gh-pr.ts`, `gh-ci.ts`, `spawn.ts`, `agent.ts`
- `lib/extensions/sandbox.ts`, `persona-prompt.ts`, `persona-memory.ts`, `abort-bridge.ts`
- `lib/pi-event-mapper.ts`
- `app/api/personas/route.ts`
- `app/personas/page.tsx`
- `__tests__/persona-repo.test.ts`, `seed-personas.test.ts`, `extensions/sandbox.test.ts`, `extensions/persona-memory.test.ts`, `extensions/persona-prompt.test.ts`, `extensions/abort-bridge.test.ts`, `pi-event-mapper.test.ts`, `personas-api.test.ts`

**Modified:**
- `db/schema.ts` (add personas, persona_memories tables; add `personaId` column on `agentSessions`)
- `lib/repo.ts` (add persona + memory CRUD)
- `lib/runs.ts` (rewrite `runOneTurn`; thread `personaId`; consume new event mapper)
- `lib/profiles.ts` (created during refactor — currently `PROFILES` lives inside `lib/runs.ts`; lift it out and change return type)
- `instrumentation.ts` (call `seedPersonas()` after user seeding)
- `package.json` (swap dep, add typebox)
- `__tests__/spawn-mcp.test.ts` → `__tests__/extensions/spawn.test.ts` (renamed, updated imports/expectations)
- `__tests__/gh-pr-mcp.test.ts` → `__tests__/extensions/gh-pr.test.ts` (same)
- `__tests__/gh-ci-mcp.test.ts` → `__tests__/extensions/gh-ci.test.ts` (same)

**Deleted (after the rewrite lands):**
- `lib/gh-pr-mcp.ts`, `lib/gh-ci-mcp.ts`, `lib/spawn-mcp.ts`, `lib/agent-mcp.ts`

---

## Phase A: Schema and personas

### Task 1: Add `personas` and `persona_memories` tables; `personaId` column on `agentSessions`

**Files:**
- Create: `db/migrations/0010_personas.sql`
- Modify: `db/schema.ts:131-173` (add `personaId` to `agentSessions`); add new `personas` and `personaMemories` tables somewhere after `users`

- [ ] **Step 1: Write the migration**

Create `db/migrations/0010_personas.sql`:

```sql
-- 0010_personas: persona registry + per-persona memory + agent_runs.persona_id.
--
-- Personas bundle (system prompt, model, tools profile, skills, memory, budgets)
-- per role. Rows are seeded from lib/personas/*.ts at boot (db/seed-personas.ts);
-- the table is queryable so agent_runs can FK to it and the UI can list options.

CREATE TABLE IF NOT EXISTS personas (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  system_prompt   TEXT NOT NULL,
  model_provider  TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  thinking_level  TEXT,
  tools_profile   TEXT NOT NULL,
  skill_paths     TEXT NOT NULL DEFAULT '[]',
  budget_max_turns    INTEGER,
  budget_max_seconds  INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE TABLE IF NOT EXISTS persona_memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  UNIQUE(persona_id, scope)
);

CREATE INDEX IF NOT EXISTS persona_memories_persona_idx
  ON persona_memories(persona_id);

ALTER TABLE agent_runs ADD COLUMN persona_id TEXT
  REFERENCES personas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_runs_persona_idx ON agent_runs(persona_id);
```

- [ ] **Step 2: Update `db/schema.ts`**

Add `personaId` to `agentSessions` (insert into the column list before `legacyChatId`):

```ts
    personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
```

Add to its index block:
```ts
    personaIdx: index("agent_runs_persona_idx").on(t.personaId),
```

Append two new tables after the `users` table:

```ts
export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt").notNull(),
  modelProvider: text("model_provider").notNull(),
  modelId: text("model_id").notNull(),
  thinkingLevel: text("thinking_level"),
  toolsProfile: text("tools_profile").notNull(),
  skillPaths: text("skill_paths").notNull().default("[]"),
  budgetMaxTurns: integer("budget_max_turns"),
  budgetMaxSeconds: integer("budget_max_seconds"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(NOW),
});

export const personaMemories = sqliteTable(
  "persona_memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    body: text("body").notNull().default(""),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  },
  (t) => ({
    personaIdx: index("persona_memories_persona_idx").on(t.personaId),
    uniq: index("persona_memories_persona_scope_uniq").on(t.personaId, t.scope),
  })
);

export type Persona = typeof personas.$inferSelect;
export type PersonaMemory = typeof personaMemories.$inferSelect;
```

(Note: the `UNIQUE` constraint is enforced by the SQL migration; the index in drizzle-kit schema is informational. Drizzle's `.unique()` modifier on an index is not used here so the migration's `UNIQUE(persona_id, scope)` is the source of truth.)

- [ ] **Step 3: Reset and reapply DB to verify migration runs**

Run: `rm -f data.db && npm run db:seed`
Expected: command exits 0; `sqlite3 data.db ".schema personas"` shows the table.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0010_personas.sql db/schema.ts
git commit -m "db: add personas + persona_memories + agent_runs.persona_id"
```

---

### Task 2: Persona repo functions

**Files:**
- Modify: `lib/repo.ts` (append a "Personas" section)
- Test: `__tests__/persona-repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/persona-repo.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../db";
import { personas as personasTable, personaMemories } from "../db/schema";
import * as repo from "../lib/repo";

function clear() {
  db.delete(personaMemories).run();
  db.delete(personasTable).run();
}

function seedReviewer() {
  db.insert(personasTable).values({
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews PRs",
    systemPrompt: "You review code.",
    modelProvider: "anthropic",
    modelId: "claude-opus-4-5",
    thinkingLevel: "high",
    toolsProfile: "repo_read,gh_pr",
    skillPaths: "[]",
  }).run();
}

describe("persona repo", () => {
  beforeEach(clear);

  it("getPersona returns null for unknown id", () => {
    expect(repo.getPersona("nope")).toBeNull();
  });

  it("getPersona returns the row for a known id", () => {
    seedReviewer();
    const p = repo.getPersona("reviewer");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("reviewer");
    expect(p!.toolsProfile).toBe("repo_read,gh_pr");
  });

  it("listPersonaIds returns sorted ids", () => {
    seedReviewer();
    db.insert(personasTable).values({
      id: "implementor", name: "Implementor", systemPrompt: "x",
      modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
      toolsProfile: "orchestrator,repo_write",
    }).run();
    expect(repo.listPersonaIds()).toEqual(["implementor", "reviewer"]);
  });

  it("getPersonaMemory returns null when none exists", () => {
    seedReviewer();
    expect(repo.getPersonaMemory("reviewer", "global")).toBeNull();
  });

  it("appendPersonaMemory creates the row on first call", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "always check tests");
    const body = repo.getPersonaMemory("reviewer", "global");
    expect(body).toBe("- always check tests");
  });

  it("appendPersonaMemory appends a bullet to existing body", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "first");
    repo.appendPersonaMemory("reviewer", "global", "second");
    const body = repo.getPersonaMemory("reviewer", "global");
    expect(body).toBe("- first\n- second");
  });

  it("removePersonaMemoryLine removes lines containing the substring", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "alpha note");
    repo.appendPersonaMemory("reviewer", "global", "beta note");
    repo.appendPersonaMemory("reviewer", "global", "gamma note");
    const removed = repo.removePersonaMemoryLine("reviewer", "global", "beta");
    expect(removed).toBe(1);
    expect(repo.getPersonaMemory("reviewer", "global")).toBe("- alpha note\n- gamma note");
  });

  it("removePersonaMemoryLine returns 0 when no match", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "alpha");
    expect(repo.removePersonaMemoryLine("reviewer", "global", "zzz")).toBe(0);
  });

  it("memory scopes are independent", () => {
    seedReviewer();
    repo.appendPersonaMemory("reviewer", "global", "g");
    repo.appendPersonaMemory("reviewer", "task-1", "t");
    expect(repo.getPersonaMemory("reviewer", "global")).toBe("- g");
    expect(repo.getPersonaMemory("reviewer", "task-1")).toBe("- t");
  });

  it("upsertPersona inserts then updates by id", () => {
    repo.upsertPersona({
      id: "qa", name: "QA", systemPrompt: "test things",
      modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
      toolsProfile: "repo_read", skillPaths: [],
    });
    expect(repo.getPersona("qa")!.systemPrompt).toBe("test things");
    repo.upsertPersona({
      id: "qa", name: "QA", systemPrompt: "test all the things",
      modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
      toolsProfile: "repo_read", skillPaths: [],
    });
    expect(repo.getPersona("qa")!.systemPrompt).toBe("test all the things");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/persona-repo.test.ts`
Expected: all tests fail with "repo.getPersona is not a function" or similar.

- [ ] **Step 3: Implement the repo functions**

Append to `lib/repo.ts` (find the existing `import` block at the top and add `personas as personasTable, personaMemories` to the schema import; then append at the end of the file):

```ts
// ──────────────────────────────────────────────────────────
// Personas
// ──────────────────────────────────────────────────────────

import type { Persona } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";

export interface PersonaUpsert {
  id: string;
  name: string;
  description?: string | null;
  systemPrompt: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel?: string | null;
  toolsProfile: string;
  skillPaths: string[];
  budgetMaxTurns?: number | null;
  budgetMaxSeconds?: number | null;
}

export function getPersona(id: string): Persona | null {
  const row = db.select().from(personasTable).where(eq(personasTable.id, id)).get();
  return row ?? null;
}

export function listPersonaIds(): string[] {
  return db
    .select({ id: personasTable.id })
    .from(personasTable)
    .orderBy(asc(personasTable.id))
    .all()
    .map((r) => r.id);
}

export function listPersonas(): Persona[] {
  return db.select().from(personasTable).orderBy(asc(personasTable.id)).all();
}

export function upsertPersona(p: PersonaUpsert): void {
  const now = new Date();
  db.insert(personasTable)
    .values({
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      systemPrompt: p.systemPrompt,
      modelProvider: p.modelProvider,
      modelId: p.modelId,
      thinkingLevel: p.thinkingLevel ?? null,
      toolsProfile: p.toolsProfile,
      skillPaths: JSON.stringify(p.skillPaths),
      budgetMaxTurns: p.budgetMaxTurns ?? null,
      budgetMaxSeconds: p.budgetMaxSeconds ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: personasTable.id,
      set: {
        name: p.name,
        description: p.description ?? null,
        systemPrompt: p.systemPrompt,
        modelProvider: p.modelProvider,
        modelId: p.modelId,
        thinkingLevel: p.thinkingLevel ?? null,
        toolsProfile: p.toolsProfile,
        skillPaths: JSON.stringify(p.skillPaths),
        budgetMaxTurns: p.budgetMaxTurns ?? null,
        budgetMaxSeconds: p.budgetMaxSeconds ?? null,
        updatedAt: now,
      },
    })
    .run();
}

export function getPersonaMemory(personaId: string, scope: string): string | null {
  const row = db
    .select({ body: personaMemories.body })
    .from(personaMemories)
    .where(and(eq(personaMemories.personaId, personaId), eq(personaMemories.scope, scope)))
    .get();
  return row ? row.body : null;
}

export function appendPersonaMemory(personaId: string, scope: string, note: string): void {
  const now = new Date();
  const trimmed = note.trim();
  if (!trimmed) return;
  const existing = getPersonaMemory(personaId, scope);
  const next = existing ? `${existing}\n- ${trimmed}` : `- ${trimmed}`;
  db.insert(personaMemories)
    .values({ personaId, scope, body: next, updatedAt: now })
    .onConflictDoUpdate({
      target: [personaMemories.personaId, personaMemories.scope],
      set: { body: next, updatedAt: now },
    })
    .run();
}

export function removePersonaMemoryLine(
  personaId: string,
  scope: string,
  match: string
): number {
  const body = getPersonaMemory(personaId, scope);
  if (!body) return 0;
  const lines = body.split("\n");
  const kept = lines.filter((l) => !l.includes(match));
  const removed = lines.length - kept.length;
  if (removed === 0) return 0;
  const now = new Date();
  db.update(personaMemories)
    .set({ body: kept.join("\n"), updatedAt: now })
    .where(and(eq(personaMemories.personaId, personaId), eq(personaMemories.scope, scope)))
    .run();
  return removed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/persona-repo.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/repo.ts __tests__/persona-repo.test.ts
git commit -m "repo: persona + persona-memory CRUD"
```

---

### Task 3: Persona TS files

**Files:**
- Create: `lib/personas/types.ts`, `lib/personas/index.ts`
- Create: `lib/personas/{reviewer,implementor,planner,designer,qa}.ts`
- Create: `lib/personas/skills/{code-review,implementation,planning,design,qa}/SKILL.md` (one minimal SKILL.md per persona)

- [ ] **Step 1: Create the type module**

`lib/personas/types.ts`:

```ts
export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: { provider: string; id: string };
  thinkingLevel?: "low" | "medium" | "high";
  toolsProfile: string;
  skillPaths: string[];
  budget?: { maxTurns?: number; maxSeconds?: number };
}
```

- [ ] **Step 2: Create the five persona files**

`lib/personas/reviewer.ts`:

```ts
import type { Persona } from "./types";

export const reviewer: Persona = {
  id: "reviewer",
  name: "Reviewer",
  description: "Reviews pull requests and proposes change requests",
  systemPrompt: `You are a code reviewer. Read the PR diff carefully, identify
correctness issues, missing tests, and deviations from project conventions.
Use gh_pr__pr_view, gh_pr__pr_diff, gh_ci__ci_runs as needed. Post
findings via gh_pr__pr_review with verdict 'comment' for non-blocking
notes or 'request_changes' for must-fix issues. Approve only when the diff
is correct, tested, and consistent with the codebase.`,
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  thinkingLevel: "high",
  toolsProfile: "repo_read,gh_pr,gh_ci",
  skillPaths: ["lib/personas/skills/code-review"],
  budget: { maxTurns: 20 },
};
```

`lib/personas/implementor.ts`:

```ts
import type { Persona } from "./types";

export const implementor: Persona = {
  id: "implementor",
  name: "Implementor",
  description: "Implements task plans, writes code, opens PRs",
  systemPrompt: `You are an implementor. Read the task body and the parent
plan if any. Make the smallest change that satisfies the acceptance criteria.
Write tests first when reasonable. Commit incrementally. When done, open a PR
with a clear summary of what changed and why.`,
  model: { provider: "anthropic", id: "claude-sonnet-4-5" },
  toolsProfile: "orchestrator,repo_write,gh_pr,spawn",
  skillPaths: ["lib/personas/skills/implementation"],
  budget: { maxTurns: 60 },
};
```

`lib/personas/planner.ts`:

```ts
import type { Persona } from "./types";

export const planner: Persona = {
  id: "planner",
  name: "Planner",
  description: "Decomposes goals into plans and tasks",
  systemPrompt: `You are a planner. Break a stated goal into a plan of small,
testable tasks with explicit acceptance criteria. Use the orchestrator tools
to create plans, tasks, and dependencies. Keep tasks bite-sized; prefer many
small tasks over one large one.`,
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  thinkingLevel: "medium",
  toolsProfile: "orchestrator,repo_read",
  skillPaths: ["lib/personas/skills/planning"],
  budget: { maxTurns: 40 },
};
```

`lib/personas/designer.ts`:

```ts
import type { Persona } from "./types";

export const designer: Persona = {
  id: "designer",
  name: "Designer",
  description: "Produces design specs and mockups",
  systemPrompt: `You are a designer. For UI work, produce ASCII mockups and
component breakdowns. For systems work, produce a short spec covering data
model, API surface, and failure modes. Save designs as markdown under
docs/specs/. Do not implement.`,
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  thinkingLevel: "medium",
  toolsProfile: "orchestrator,repo_write",
  skillPaths: ["lib/personas/skills/design"],
  budget: { maxTurns: 30 },
};
```

`lib/personas/qa.ts`:

```ts
import type { Persona } from "./types";

export const qa: Persona = {
  id: "qa",
  name: "QA",
  description: "Tests features end-to-end against acceptance criteria",
  systemPrompt: `You are a QA engineer. Read the task's acceptance criteria,
exercise the feature (CLI, API, UI as appropriate), and report which criteria
pass or fail with concrete evidence (commands run, outputs observed). Do not
modify product code; you may write or fix tests.`,
  model: { provider: "anthropic", id: "claude-sonnet-4-5" },
  toolsProfile: "orchestrator,repo_read,gh_pr,gh_ci",
  skillPaths: ["lib/personas/skills/qa"],
  budget: { maxTurns: 30 },
};
```

- [ ] **Step 3: Create the index module**

`lib/personas/index.ts`:

```ts
import type { Persona } from "./types";
import { reviewer } from "./reviewer";
import { implementor } from "./implementor";
import { planner } from "./planner";
import { designer } from "./designer";
import { qa } from "./qa";

export type { Persona };
export const PERSONAS: ReadonlyArray<Persona> = [
  reviewer,
  implementor,
  planner,
  designer,
  qa,
];
```

- [ ] **Step 4: Create one SKILL.md per persona**

For each `<id>` in `code-review, implementation, planning, design, qa`, create `lib/personas/skills/<id>/SKILL.md`:

`lib/personas/skills/code-review/SKILL.md`:

```markdown
---
name: code-review
description: Reviewing a pull request — what to look for, how to phrase feedback.
---

# Code review

When reviewing a PR:

1. Read the description first; what is the PR claiming to do?
2. Read the test diff before the implementation diff; tests describe intent.
3. Look for: missing tests, off-by-one errors, broken invariants, dead code,
   inconsistent naming, unhandled error paths.
4. Phrase findings as "what" + "why it matters" + "suggested fix".
5. Use `request_changes` only for correctness or test issues; use `comment`
   for stylistic or scope notes.
```

`lib/personas/skills/implementation/SKILL.md`:

```markdown
---
name: implementation
description: Implementing a task — incremental commits, smallest viable change.
---

# Implementation

1. Read the task body and any acceptance criteria before writing code.
2. Make the smallest change that satisfies the criteria; resist scope creep.
3. Write tests first when the change is non-trivial.
4. Commit at every green test; one logical change per commit.
5. Open the PR with a summary that mirrors the task title and links the task id.
```

`lib/personas/skills/planning/SKILL.md`:

```markdown
---
name: planning
description: Breaking a goal into bite-sized tasks with acceptance criteria.
---

# Planning

1. State the goal in one sentence.
2. Identify the seams: what files change, what data shape changes, what
   subsystems are involved.
3. Decompose into tasks where each task is independently testable and
   <= 1 day of work.
4. Each task gets at least one acceptance criterion phrased as an
   observable behaviour.
5. Order tasks so each one builds on the previous.
```

`lib/personas/skills/design/SKILL.md`:

```markdown
---
name: design
description: Producing a design spec — data model, API surface, failure modes.
---

# Design

1. State the problem in one paragraph.
2. Sketch the data model: what tables/columns/types are added or changed.
3. Sketch the API surface: function signatures or HTTP routes.
4. List failure modes: what can break, what each break looks like to a user,
   how it's surfaced.
5. Keep the spec under 1000 words. Save to `docs/specs/YYYY-MM-DD-<topic>.md`.
```

`lib/personas/skills/qa/SKILL.md`:

```markdown
---
name: qa
description: Testing a feature against acceptance criteria with concrete evidence.
---

# QA

1. List the acceptance criteria.
2. For each, perform the smallest action that exercises it (CLI command, API
   call, UI click).
3. Record the input and the observed output verbatim.
4. Mark each criterion PASS / FAIL / BLOCKED. For FAIL, include the
   reproduction.
5. If a behaviour surprised you but no criterion covers it, file a follow-up
   note rather than failing silently.
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/personas/
git commit -m "personas: define reviewer, implementor, planner, designer, qa"
```

---

### Task 4: Seed personas at boot

**Files:**
- Create: `db/seed-personas.ts`
- Modify: `instrumentation.ts`
- Test: `__tests__/seed-personas.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/seed-personas.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { listPersonaIds, getPersona } from "../lib/repo";

describe("seedPersonas", () => {
  beforeEach(() => {
    db.delete(personasTable).run();
  });

  it("inserts all five personas on first call", () => {
    seedPersonas();
    expect(listPersonaIds().sort()).toEqual(
      ["designer", "implementor", "planner", "qa", "reviewer"]
    );
  });

  it("is idempotent — second call is a no-op semantically", () => {
    seedPersonas();
    seedPersonas();
    expect(listPersonaIds()).toHaveLength(5);
  });

  it("updates an existing persona when its TS definition changes", () => {
    seedPersonas();
    db.update(personasTable)
      .set({ systemPrompt: "stale" })
      .where(/* drift the row */ undefined as unknown as never)
      .run();
    seedPersonas();
    const r = getPersona("reviewer")!;
    expect(r.systemPrompt).toContain("code reviewer");
  });

  it("reviewer persona has expected shape", () => {
    seedPersonas();
    const r = getPersona("reviewer")!;
    expect(r.modelProvider).toBe("anthropic");
    expect(r.modelId).toBe("claude-opus-4-5");
    expect(r.toolsProfile).toContain("gh_pr");
    expect(JSON.parse(r.skillPaths)).toContain("lib/personas/skills/code-review");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/seed-personas.test.ts`
Expected: fails on `cannot find module "../db/seed-personas"`.

- [ ] **Step 3: Implement the seed module**

Create `db/seed-personas.ts`:

```ts
import { PERSONAS } from "@/lib/personas";
import * as repo from "@/lib/repo";

export function seedPersonas(): void {
  for (const p of PERSONAS) {
    repo.upsertPersona({
      id: p.id,
      name: p.name,
      description: p.description,
      systemPrompt: p.systemPrompt,
      modelProvider: p.model.provider,
      modelId: p.model.id,
      thinkingLevel: p.thinkingLevel ?? null,
      toolsProfile: p.toolsProfile,
      skillPaths: p.skillPaths,
      budgetMaxTurns: p.budget?.maxTurns ?? null,
      budgetMaxSeconds: p.budget?.maxSeconds ?? null,
    });
  }
}
```

- [ ] **Step 4: Wire into `instrumentation.ts`**

Open `instrumentation.ts`. After the existing user seeding, add:

```ts
const { seedPersonas } = await import("@/db/seed-personas");
seedPersonas();
```

(Place it inside the same `register()` async function that already imports `@/db`.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run __tests__/seed-personas.test.ts`
Expected: all four tests pass. (Note: the third test's `where(... undefined as unknown as never)` is a placeholder — replace with `where(eq(personasTable.id, "reviewer"))` after importing `eq` from `drizzle-orm`. Update the test before running.)

Final form of test 3:

```ts
  it("updates an existing persona when its TS definition changes", () => {
    seedPersonas();
    db.update(personasTable)
      .set({ systemPrompt: "stale" })
      .where(eq(personasTable.id, "reviewer"))
      .run();
    seedPersonas();
    const r = getPersona("reviewer")!;
    expect(r.systemPrompt).toContain("code reviewer");
  });
```

(Add `import { eq } from "drizzle-orm";` at the top of the test file.)

- [ ] **Step 6: Commit**

```bash
git add db/seed-personas.ts instrumentation.ts __tests__/seed-personas.test.ts
git commit -m "personas: seed at boot from lib/personas/*"
```

---

## Phase B: Pi dependency swap

### Task 5: Replace SDK dep with pi.dev

**Files:**
- Modify: `package.json`
- Run: `npm install`

- [ ] **Step 1: Resolve the actual package name for TypeBox**

The pi.dev SDK docs reference `import { Type } from "typebox"`, but the canonical npm package is `@sinclair/typebox`. Run:

```bash
npm view typebox version
npm view @sinclair/typebox version
```

If `typebox` 404s (likely), the dep to add is `@sinclair/typebox` and **every `from "typebox"` import in this plan must be rewritten to `from "@sinclair/typebox"`** before use. Pick the variant that exists; record the choice for the rest of the tasks.

- [ ] **Step 2: Edit `package.json`**

In the `dependencies` block:
- Remove: `"@anthropic-ai/claude-agent-sdk": "^0.1.0"`
- Add: `"@earendil-works/pi-coding-agent": "<latest>"` (run `npm view @earendil-works/pi-coding-agent version` and pin to that major.minor with `^`)
- Add: TypeBox under whichever name resolved in Step 1, pinned to `^<latest>`.

- [ ] **Step 3: Install**

Run: `npm install`
Expected: lockfile updated; no errors. Note: TypeScript will start failing in files that import `@anthropic-ai/claude-agent-sdk` — that is expected; it is fixed in subsequent tasks.

- [ ] **Step 4: Sanity-check the new package surface**

Run: `node -e "console.log(Object.keys(require('@earendil-works/pi-coding-agent')))"`
Expected: output includes `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, `DefaultResourceLoader`, `getModel`, `isToolCallEventType`. If any are missing, stop and re-check the package version against `https://pi.dev/docs/latest/sdk`. If a name is exported under a slightly different identifier (e.g. `createSession` instead of `createAgentSession`), update the imports in subsequent tasks accordingly.

- [ ] **Step 5: Commit (lockfile only — TypeScript still broken intentionally)**

```bash
git add package.json package-lock.json
git commit -m "deps: swap @anthropic-ai/claude-agent-sdk for @earendil-works/pi-coding-agent + typebox"
```

---

## Phase C: Extension ports

### Task 6: Shared extension types

**Files:**
- Create: `lib/extensions/types.ts`

- [ ] **Step 1: Create the module**

```ts
// lib/extensions/types.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A pi extension factory. The runner builds an array of these per turn from
 * the persona + run config, then hands them to DefaultResourceLoader.
 */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Same shape as the old McpServerFactory ProfileContext, kept for parity. */
export interface ProfileContext {
  runId: number;
  run: import("@/lib/runs").RunRow;
  author: string;
  taskId: string | null;
  cwd: string;
}
```

- [ ] **Step 2: Verify it compiles in isolation**

Run: `npx tsc --noEmit lib/extensions/types.ts`
Expected: errors only from the inability to resolve `@/lib/runs` (path alias resolved by Next, not by `tsc` standalone). Acceptable — `npm run typecheck` will validate it in context once Task 17 lands.

- [ ] **Step 3: Commit**

```bash
git add lib/extensions/types.ts
git commit -m "extensions: shared types module"
```

---

### Task 7: Port `gh-pr` MCP server to pi extension

**Files:**
- Create: `lib/extensions/gh-pr.ts`
- Modify: `__tests__/gh-pr-mcp.test.ts` → rename and rewrite as `__tests__/extensions/gh-pr.test.ts`
- Delete (in Task 17): `lib/gh-pr-mcp.ts`

- [ ] **Step 1: Read the source**

Read `lib/gh-pr-mcp.ts` end-to-end. It exports `createGhPrMcpServer({ cwd })` registering five tools: `pr_view`, `pr_diff`, `pr_review`, `pr_comment`, `pr_merge`. Helpers (`gh()`, `summarizeChecks`, `filterDiffByFile`, `tryParseJson`, `gate`) stay; only the MCP shell changes.

- [ ] **Step 2: Create the extension**

Create `lib/extensions/gh-pr.ts`. Translation rules:
- Replace `import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"` → `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; import { Type } from "typebox";`
- Replace `tool("name", "desc", { x: z.string() }, async ({x}) => ...)` → `pi.registerTool({ name: "gh_pr__name", description: "desc", parameters: Type.Object({ x: Type.String({ minLength: 1 }) }), execute: async (_id, { x }) => ... })`
- Map zod helpers: `z.string().min(1)` → `Type.String({ minLength: 1 })`; `z.string().optional()` → `Type.Optional(Type.String())`; `z.number().int().positive()` → `Type.Integer({ minimum: 1 })`; `z.enum(["a","b"])` → `import { StringEnum } from "@earendil-works/pi-ai"` then `StringEnum(["a","b"] as const)`.
- Tool names: prefix every tool with `gh_pr__` (so `pr_view` → `gh_pr__pr_view`, etc.).
- Return shape: identical (`{ content: [...], isError?: boolean }`).
- The factory exports a function that takes `(opts: { cwd?: string })` and returns an `ExtensionFactory`.

Concrete worked example for `pr_view` (apply the same shape to the other four):

```ts
// lib/extensions/gh-pr.ts
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  ownerRepoFromRemote, parsePrUrl, validatePrUrl,
  type ParsedPrUrl, type UrlValidation,
} from "../gh-url";
import type { ExtensionFactory } from "./types";

export { ownerRepoFromRemote, parsePrUrl, validatePrUrl };
export type { ParsedPrUrl, UrlValidation };

interface GhResult { code: number; stdout: string; stderr: string; }

function gh(args: string[], cwd: string | undefined): Promise<GhResult> {
  return new Promise((resolveP) => {
    const child = spawn("gh", args, { env: process.env, cwd });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolveP({ code: -1, stdout, stderr: stderr + String(err) })
    );
    child.on("close", (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], isError: true });

export interface GhPrExtensionOptions { cwd?: string; }

export const ghPrExtension =
  (opts: GhPrExtensionOptions = {}): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    const cwd = opts.cwd;

    function gate(url: string):
      | { ok: true; parsed: ParsedPrUrl; matched: { id: string; name: string } }
      | { ok: false; result: ReturnType<typeof errResult> } {
      const v = validatePrUrl(url);
      if ("error" in v) return { ok: false, result: errResult(v.error) };
      return { ok: true, parsed: v.parsed, matched: v.matched };
    }

    pi.registerTool({
      name: "gh_pr__pr_view",
      description: "Fetch a PR's metadata: state, mergeable, CI status, title, body, files. Pass the PR URL or short form (owner/repo#n).",
      parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
      execute: async (_id, { url }) => {
        const g = gate(url);
        if (!g.ok) return g.result;
        const fields = "state,mergeable,mergeStateStatus,title,body,url,number,headRefName,baseRefName,author,createdAt,updatedAt,mergedAt,files,statusCheckRollup,isDraft,additions,deletions,changedFiles";
        const r = await gh(["pr", "view", g.parsed.canonical, "--json", fields], cwd);
        if (r.code !== 0) {
          return errResult(r.stderr.trim() || `gh pr view failed (exit ${r.code})`);
        }
        let raw: Record<string, unknown>;
        try { raw = JSON.parse(r.stdout) as Record<string, unknown>; }
        catch { return errResult(`gh pr view returned non-JSON: ${r.stdout.slice(0, 200)}`); }
        const checks = Array.isArray(raw.statusCheckRollup)
          ? (raw.statusCheckRollup as Array<Record<string, unknown>>) : [];
        const ciStatus = summarizeChecks(checks);
        const payload = {
          url: raw.url ?? g.parsed.canonical,
          number: raw.number ?? g.parsed.number,
          state: raw.state ?? null,
          mergeable: raw.mergeable ?? null,
          merge_state_status: raw.mergeStateStatus ?? null,
          ci_status: ciStatus,
          title: raw.title ?? null,
          body: raw.body ?? null,
          head_ref: raw.headRefName ?? null,
          base_ref: raw.baseRefName ?? null,
          author: raw.author ?? null,
          is_draft: raw.isDraft ?? null,
          additions: raw.additions ?? null,
          deletions: raw.deletions ?? null,
          changed_files: raw.changedFiles ?? null,
          files: Array.isArray(raw.files) ? raw.files : [],
          repo: g.matched,
        };
        return ok(JSON.stringify(payload, null, 2));
      },
    });

    // ... pr_diff, pr_review, pr_comment, pr_merge — apply the same translation
    //     pattern as above. Names: gh_pr__pr_diff, gh_pr__pr_review,
    //     gh_pr__pr_comment, gh_pr__pr_merge.
  };

// Helpers (verbatim from old file)
function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function summarizeChecks(checks: Array<Record<string, unknown>>): {
  state: "SUCCESS" | "FAILURE" | "PENDING" | "NEUTRAL" | "NONE";
  total: number; success: number; failure: number;
  pending: number; neutral: number;
} {
  // ... copy verbatim from lib/gh-pr-mcp.ts:317-367
}

export function filterDiffByFile(diff: string, file: string): string {
  // ... copy verbatim from lib/gh-pr-mcp.ts:371-389
}
```

Replace the `// ...` ellipses by copying the corresponding code blocks verbatim from `lib/gh-pr-mcp.ts`. Apply the `gh_pr__` prefix to every tool registered.

For `verdict` and `method` enum params: `Type.Union([Type.Literal("approve"), Type.Literal("comment"), Type.Literal("request_changes")])` works without `StringEnum` if you prefer to avoid the `@earendil-works/pi-ai` dep.

- [ ] **Step 3: Port the test file**

Move `__tests__/gh-pr-mcp.test.ts` → `__tests__/extensions/gh-pr.test.ts`. The tests today exercise the pure helpers (`filterDiffByFile`, `summarizeChecks`) which still exist as exports; updates needed:

- Update import path: `from "../../lib/extensions/gh-pr"` (note the `../../` because the file moved one level deeper).
- If any test invoked `createGhPrMcpServer` directly to assert tool registrations, replace with: build a stub `ExtensionAPI` that captures `registerTool` calls, invoke `ghPrExtension({ cwd: "/tmp" })(stub)`, then assert the captured names and parameter shapes. Stub:

```ts
function makeStub(): { calls: Array<{ name: string; def: any }>; pi: any } {
  const calls: Array<{ name: string; def: any }> = [];
  const pi = {
    registerTool: (def: any) => { calls.push({ name: def.name, def }); },
    on: () => {},
    registerCommand: () => {},
    // ... no-op the rest as needed
  };
  return { calls, pi };
}
```

Add a new test:

```ts
import { describe, expect, it } from "vitest";
import { ghPrExtension } from "../../lib/extensions/gh-pr";

describe("ghPrExtension", () => {
  it("registers the five gh_pr tools", () => {
    const { calls, pi } = makeStub();
    ghPrExtension({ cwd: "/tmp" })(pi);
    const names = calls.map((c) => c.name).sort();
    expect(names).toEqual([
      "gh_pr__pr_comment",
      "gh_pr__pr_diff",
      "gh_pr__pr_merge",
      "gh_pr__pr_review",
      "gh_pr__pr_view",
    ]);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/extensions/gh-pr.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/extensions/gh-pr.ts __tests__/extensions/gh-pr.test.ts
git rm __tests__/gh-pr-mcp.test.ts
git commit -m "extensions: port gh-pr MCP server to pi extension"
```

(Do NOT delete `lib/gh-pr-mcp.ts` yet — `lib/runs.ts` still imports it. The delete happens in Task 17 alongside the runs.ts rewrite.)

---

### Task 8: Port `gh-ci` MCP server

**Files:**
- Create: `lib/extensions/gh-ci.ts`
- Move: `__tests__/gh-ci-mcp.test.ts` → `__tests__/extensions/gh-ci.test.ts`

- [ ] **Step 1: Read the source**

Read `lib/gh-ci-mcp.ts` to identify every tool defined inside `createSdkMcpServer({ name: "gh_ci", tools: [...] })`. Each `tool(name, desc, schema, handler)` becomes a `pi.registerTool` call with name prefix `gh_ci__`.

- [ ] **Step 2: Create the extension**

Apply the same translation pattern from Task 7 step 2. Skeleton:

```ts
// lib/extensions/gh-ci.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionFactory } from "./types";

export interface GhCiExtensionOptions { cwd?: string; }

export const ghCiExtension =
  (opts: GhCiExtensionOptions = {}): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    const cwd = opts.cwd;
    // For each tool in lib/gh-ci-mcp.ts, register here with name 'gh_ci__<oldName>'.
    // Helpers (gh subprocess wrapper, JSON parsing, etc.) come along verbatim.
  };
```

Apply the schema translation rules from Task 7 (zod → TypeBox).

- [ ] **Step 3: Port the test file**

Move `__tests__/gh-ci-mcp.test.ts` → `__tests__/extensions/gh-ci.test.ts`. Update import paths. Keep pure-helper tests intact. Add a registration test:

```ts
import { ghCiExtension } from "../../lib/extensions/gh-ci";
// ... reuse the makeStub() helper from Task 7

it("registers expected gh_ci tools", () => {
  const { calls, pi } = makeStub();
  ghCiExtension({ cwd: "/tmp" })(pi);
  // Replace the expected list with whatever lib/gh-ci-mcp.ts exposes —
  // current tools are gh_ci__ci_runs, gh_ci__ci_logs, gh_ci__ci_rerun
  // (per commit aacd27b). Confirm by re-reading lib/gh-ci-mcp.ts.
  expect(calls.map(c => c.name).sort()).toEqual([
    "gh_ci__ci_logs", "gh_ci__ci_rerun", "gh_ci__ci_runs",
  ]);
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/extensions/gh-ci.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/extensions/gh-ci.ts __tests__/extensions/gh-ci.test.ts
git rm __tests__/gh-ci-mcp.test.ts
git commit -m "extensions: port gh-ci MCP server to pi extension"
```

---

### Task 9: Port `agent` (orchestrator) MCP server

**Files:**
- Create: `lib/extensions/agent.ts`

- [ ] **Step 1: Read the source**

Read `lib/agent-mcp.ts`. The factory is `createOrchestratorMcpServer({ author, defaultTaskId? })`. Identify every registered tool — these are the orchestrator surface (plans, tasks, notes, criteria, sessions).

- [ ] **Step 2: Create the extension**

Apply the same pattern. Skeleton:

```ts
// lib/extensions/agent.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionFactory } from "./types";

export interface OrchestratorExtensionOptions {
  author: string;
  defaultTaskId?: string;
}

export const orchestratorExtension =
  (opts: OrchestratorExtensionOptions): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    // For every tool in lib/agent-mcp.ts, pi.registerTool with name
    // 'task_orch__<oldName>'. Translate zod → TypeBox per Task 7's table.
    // Pure handlers stay; helpers stay.
  };
```

- [ ] **Step 3: Verify TypeScript compiles in isolation**

Run: `npm run typecheck` and confirm errors are limited to `lib/runs.ts` still importing the old MCP files (expected — fixed in Task 17).

- [ ] **Step 4: Commit**

```bash
git add lib/extensions/agent.ts
git commit -m "extensions: port agent (orchestrator) MCP server to pi extension"
```

---

### Task 10: Port `spawn` MCP server (with new `persona` arg)

**Files:**
- Create: `lib/extensions/spawn.ts`
- Move: `__tests__/spawn-mcp.test.ts` → `__tests__/extensions/spawn.test.ts`

- [ ] **Step 1: Read the source**

Read `lib/spawn-mcp.ts`. Three tools: `spawn_agent`, `get_run`, `append_message`. Pure helpers (`computeDepth`, `sumTreeCost`, `checkTreeBudget`, `extractLatestAssistantText`, `checkAppendableStatus`) stay as exports for the existing unit tests.

- [ ] **Step 2: Create the extension with `persona` required on `spawn_agent`**

Translation: each tool → `pi.registerTool({ name: "spawn__<old>", ... })`. For `spawn_agent`, **add a required `persona` field to the schema** and validate against `repo.listPersonaIds()`:

```ts
pi.registerTool({
  name: "spawn__spawn_agent",
  description: "Spawn a child agent run. Returns immediately with the new run_id; poll spawn__get_run(id) for status. Enforces a depth cap of 3 on the parent chain and a tree-wide cost cap. The 'persona' field selects the agent role (reviewer | implementor | planner | designer | qa).",
  parameters: Type.Object({
    goal: Type.String({ minLength: 1 }),
    persona: Type.String({ minLength: 1 }),
    tools_profile: Type.Optional(Type.String({ minLength: 1 })),
    cwd_strategy: Type.Union([
      Type.Literal("worktree"), Type.Literal("repo"), Type.Literal("none"),
    ]),
    task_id: Type.Optional(Type.String()),
    pr_url: Type.Optional(Type.String()),
    repo_id: Type.Optional(Type.String()),
    budget_max_usd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    budget_max_turns: Type.Optional(Type.Integer({ minimum: 1 })),
    title: Type.Optional(Type.String()),
    initial_prompt: Type.Optional(Type.String()),
  }),
  execute: async (_id, args) => {
    // 1. Persona validation
    const validIds = repo.listPersonaIds();
    if (!validIds.includes(args.persona)) {
      return errResult(
        `Unknown persona '${args.persona}'. Valid: ${validIds.join(", ")}`
      );
    }
    // 2. Existing depth + tree-budget checks (copy verbatim from spawn-mcp.ts:321-352)
    // 3. runs.create() now passes personaId: args.persona
    //    (the runs.create signature is extended in Task 17 to accept personaId)
    // 4. Return shape unchanged.
  },
});
```

`tools_profile` becomes optional — when absent, `runs.create` will fall back to `persona.toolsProfile`. Same change in the runs-side resolver in Task 17.

`get_run` and `append_message` translate one-to-one with the same logic, just `pi.registerTool` shells.

- [ ] **Step 3: Port the test file**

Move `__tests__/spawn-mcp.test.ts` → `__tests__/extensions/spawn.test.ts`:
- Update import path to `../../lib/extensions/spawn`.
- Pure-helper tests (`computeDepth`, `sumTreeCost`, `checkTreeBudget`, `extractLatestAssistantText`, `checkAppendableStatus`) stay verbatim.
- Add a registration test (same `makeStub` pattern as Task 7):

```ts
it("spawn__spawn_agent rejects unknown persona", async () => {
  // Seed personas first; then invoke the captured execute() with persona='nope'.
  // Expect isError: true and a message listing valid persona ids.
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/extensions/spawn.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/extensions/spawn.ts __tests__/extensions/spawn.test.ts
git rm __tests__/spawn-mcp.test.ts
git commit -m "extensions: port spawn MCP server; require persona on spawn_agent"
```

---

## Phase D: New extensions

### Task 11: Sandbox extension (`tool_call`-based filesystem gate)

**Files:**
- Create: `lib/extensions/sandbox.ts`
- Test: `__tests__/extensions/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/extensions/sandbox.test.ts
import { describe, expect, it } from "vitest";
import { sandboxFactory } from "../../lib/extensions/sandbox";

function makeStub() {
  const handlers = new Map<string, Function>();
  const pi = {
    on: (event: string, handler: Function) => { handlers.set(event, handler); },
    registerTool: () => {},
  };
  return { handlers, pi };
}

async function fireToolCall(handlers: Map<string, Function>, event: any) {
  const fn = handlers.get("tool_call");
  if (!fn) throw new Error("no tool_call handler");
  return fn(event, {});
}

describe("sandboxFactory", () => {
  it("blocks write outside cwd", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi as any);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: "/etc/passwd" },
    });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("/work"),
    });
  });

  it("allows write inside cwd", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi as any);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: "/work/src/foo.ts" },
    });
    expect(result).toBeUndefined();
  });

  it("allows write with relative path resolved inside cwd", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi as any);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: "src/foo.ts" },
    });
    expect(result).toBeUndefined();
  });

  it("blocks edit outside cwd", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi as any);
    const result = await fireToolCall(handlers, {
      toolName: "edit",
      input: { path: "/etc/hosts" },
    });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("/work") });
  });

  it("rejects path-traversal escape via ..", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi as any);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: "/work/../etc/passwd" },
    });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("/work") });
  });

  it("injects TASK_ORCH_DB into bash commands", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi as any);
    const event = { toolName: "bash", input: { command: "ls" } };
    await fireToolCall(handlers, event);
    expect(event.input.command).toContain("export TASK_ORCH_DB='/sandbox/data.db'");
    expect(event.input.command).toContain("ls");
  });

  it("escapes single quotes in sandbox db path", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/with'quote.db")(pi as any);
    const event = { toolName: "bash", input: { command: "ls" } };
    await fireToolCall(handlers, event);
    expect(event.input.command).toContain("'/sandbox/with'\\''quote.db'");
  });

  it("ignores non-string write paths", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi as any);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: undefined },
    });
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/extensions/sandbox.test.ts`
Expected: fails on `Cannot find module '../../lib/extensions/sandbox'`.

- [ ] **Step 3: Implement the sandbox extension**

```ts
// lib/extensions/sandbox.ts
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "./types";

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export const sandboxFactory =
  (cwd: string, sandboxDbPath: string): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event: any) => {
      if (event.toolName === "write" || event.toolName === "edit") {
        const target = event.input?.path;
        if (typeof target !== "string") return;
        const abs = path.resolve(cwd, target);
        const inside = abs === cwd || abs.startsWith(cwd + path.sep);
        if (!inside) {
          return { block: true, reason: `Write outside ${cwd} denied` };
        }
        return;
      }
      if (event.toolName === "bash" && typeof event.input?.command === "string") {
        event.input.command =
          `export TASK_ORCH_DB=${shellEscape(sandboxDbPath)}\n` +
          event.input.command;
      }
    });
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/extensions/sandbox.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/extensions/sandbox.ts __tests__/extensions/sandbox.test.ts
git commit -m "extensions: filesystem sandbox via tool_call hook"
```

---

### Task 12: Persona-prompt extension

**Files:**
- Create: `lib/extensions/persona-prompt.ts`
- Test: `__tests__/extensions/persona-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/extensions/persona-prompt.test.ts
import { describe, expect, it } from "vitest";
import { personaPromptFactory } from "../../lib/extensions/persona-prompt";
import type { Persona } from "../../lib/personas/types";

const persona: Persona = {
  id: "x", name: "X", description: "", systemPrompt: "YOU ARE X.",
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  toolsProfile: "", skillPaths: [],
};

describe("personaPromptFactory", () => {
  it("sets systemPromptPrefix on before_agent_start", async () => {
    const handlers = new Map<string, Function>();
    const pi: any = { on: (e: string, h: Function) => handlers.set(e, h), registerTool: () => {} };
    personaPromptFactory(persona)(pi);
    const event: any = {};
    await handlers.get("before_agent_start")!(event, {});
    expect(event.systemPromptPrefix).toBe("YOU ARE X.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/extensions/persona-prompt.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

```ts
// lib/extensions/persona-prompt.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "./types";
import type { Persona } from "@/lib/personas/types";

export const personaPromptFactory =
  (persona: Persona): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event: any) => {
      event.systemPromptPrefix = persona.systemPrompt;
    });
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/extensions/persona-prompt.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/extensions/persona-prompt.ts __tests__/extensions/persona-prompt.test.ts
git commit -m "extensions: inject persona system prompt via before_agent_start"
```

---

### Task 13: Persona-memory extension

**Files:**
- Create: `lib/extensions/persona-memory.ts`
- Test: `__tests__/extensions/persona-memory.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/extensions/persona-memory.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { personaMemoryFactory } from "../../lib/extensions/persona-memory";
import { db } from "../../db";
import { personas as personasTable, personaMemories } from "../../db/schema";
import * as repo from "../../lib/repo";
import type { Persona } from "../../lib/personas/types";

const persona: Persona = {
  id: "reviewer", name: "Reviewer", description: "",
  systemPrompt: "review code",
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  toolsProfile: "repo_read", skillPaths: [],
};

function makeStub() {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const pi: any = {
    on: (e: string, h: Function) => handlers.set(e, h),
    registerTool: (def: any) => tools.set(def.name, def),
  };
  return { handlers, tools, pi };
}

describe("personaMemoryFactory", () => {
  let cwd: string;

  beforeEach(async () => {
    db.delete(personaMemories).run();
    db.delete(personasTable).run();
    db.insert(personasTable).values({
      id: "reviewer", name: "Reviewer", systemPrompt: "x",
      modelProvider: "anthropic", modelId: "claude-opus-4-5",
      toolsProfile: "repo_read",
    }).run();
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "persona-mem-"));
  });

  it("writes a SKILL.md with empty body when no memory exists", async () => {
    const { handlers, pi } = makeStub();
    const run: any = { taskId: null, repoId: null };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    await handlers.get("before_agent_start")!({}, {});
    const skill = await fs.readFile(
      path.join(cwd, ".pi", "skills", "persona-memory-reviewer", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: persona-memory-reviewer");
    expect(skill).toContain("description:");
  });

  it("writes a SKILL.md including bullets from each scope that has body", async () => {
    repo.appendPersonaMemory("reviewer", "global", "always check tests");
    repo.appendPersonaMemory("reviewer", "repo-1", "this repo uses vitest");
    const { handlers, pi } = makeStub();
    const run: any = { taskId: null, repoId: "repo-1" };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    await handlers.get("before_agent_start")!({}, {});
    const skill = await fs.readFile(
      path.join(cwd, ".pi", "skills", "persona-memory-reviewer", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("always check tests");
    expect(skill).toContain("this repo uses vitest");
  });

  it("registers memory_remember and memory_forget tools", () => {
    const { tools, pi } = makeStub();
    const run: any = { taskId: "t-1", repoId: "r-1" };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    expect(tools.has("memory_remember")).toBe(true);
    expect(tools.has("memory_forget")).toBe(true);
  });

  it("memory_remember at task scope persists to the task scope key", async () => {
    const { tools, pi } = makeStub();
    const run: any = { taskId: "T-1", repoId: "R-1" };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    const def = tools.get("memory_remember")!;
    await def.execute("call-1", { scope: "task", note: "watch out for this" });
    expect(repo.getPersonaMemory("reviewer", "T-1")).toBe("- watch out for this");
  });

  it("memory_remember errors when scope is unavailable on this run", async () => {
    const { tools, pi } = makeStub();
    const run: any = { taskId: null, repoId: null };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    const def = tools.get("memory_remember")!;
    const result = await def.execute("call-1", { scope: "task", note: "x" });
    expect(result.isError).toBe(true);
  });

  it("memory_forget removes matching lines and reports count", async () => {
    repo.appendPersonaMemory("reviewer", "global", "alpha");
    repo.appendPersonaMemory("reviewer", "global", "beta");
    const { tools, pi } = makeStub();
    const run: any = { taskId: null, repoId: null };
    personaMemoryFactory(persona, run, repo, cwd)(pi);
    const result = await tools.get("memory_forget")!.execute("call-1", {
      scope: "global", match: "alpha",
    });
    expect(result.content[0].text).toContain("Removed 1");
    expect(repo.getPersonaMemory("reviewer", "global")).toBe("- beta");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/extensions/persona-memory.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

```ts
// lib/extensions/persona-memory.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

function renderMemorySkill(
  persona: Persona,
  blocks: Array<{ scope: string; body: string }>
): string {
  const description = `Cross-session notes the ${persona.name} persona has written about itself, the current repo, and the current task.`;
  const front = `---\nname: persona-memory-${persona.id}\ndescription: ${description}\n---\n`;
  if (blocks.length === 0) {
    return `${front}\n# ${persona.name} memory\n\n(no notes yet)\n`;
  }
  const body = blocks
    .map((b) => `## ${b.scope}\n\n${b.body}`)
    .join("\n\n");
  return `${front}\n# ${persona.name} memory\n\n${body}\n`;
}

export const personaMemoryFactory =
  (persona: Persona, run: RunLite, repo: MemoryRepo, cwd: string): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async () => {
      const scopeKeys = ["global", run.repoId, run.taskId].filter(
        (s): s is string => typeof s === "string" && s.length > 0
      );
      const blocks: Array<{ scope: string; body: string }> = [];
      for (const s of scopeKeys) {
        const body = repo.getPersonaMemory(persona.id, s);
        if (body && body.trim().length > 0) blocks.push({ scope: s, body });
      }
      const skillDir = path.join(cwd, ".pi", "skills", `persona-memory-${persona.id}`);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), renderMemorySkill(persona, blocks));
    });

    pi.registerTool({
      name: "memory_remember",
      description: "Persist a note to this persona's memory at one of three scopes (global / repo / task).",
      parameters: Type.Object({
        scope: Type.Union([
          Type.Literal("global"),
          Type.Literal("repo"),
          Type.Literal("task"),
        ]),
        note: Type.String({ minLength: 1 }),
      }),
      execute: async (_id, { scope, note }) => {
        const scopeKey =
          scope === "global" ? "global" :
          scope === "repo"   ? run.repoId :
                               run.taskId;
        if (!scopeKey) {
          return {
            content: [{ type: "text" as const,
              text: `No ${scope} scope on this run; cannot remember at that scope.` }],
            isError: true,
          };
        }
        repo.appendPersonaMemory(persona.id, scopeKey, note);
        return { content: [{ type: "text" as const, text: `Remembered (${scope}).` }] };
      },
    });

    pi.registerTool({
      name: "memory_forget",
      description: "Remove memory lines containing the given substring within a scope.",
      parameters: Type.Object({
        scope: Type.String({ minLength: 1 }),
        match: Type.String({ minLength: 1 }),
      }),
      execute: async (_id, { scope, match }) => {
        const scopeKey =
          scope === "global" ? "global" :
          scope === "repo"   ? run.repoId :
          scope === "task"   ? run.taskId :
                               scope; // raw scope key for direct addressing
        if (!scopeKey) {
          return {
            content: [{ type: "text" as const, text: `No such scope on this run.` }],
            isError: true,
          };
        }
        const removed = repo.removePersonaMemoryLine(persona.id, scopeKey, match);
        return { content: [{ type: "text" as const, text: `Removed ${removed} entry/entries.` }] };
      },
    });
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/extensions/persona-memory.test.ts`
Expected: all six tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/extensions/persona-memory.ts __tests__/extensions/persona-memory.test.ts
git commit -m "extensions: persona memory (memory.md skill + remember/forget tools)"
```

---

### Task 14: Abort-bridge extension

**Files:**
- Create: `lib/extensions/abort-bridge.ts`
- Test: `__tests__/extensions/abort-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/extensions/abort-bridge.test.ts
import { describe, expect, it } from "vitest";
import { abortBridgeFactory } from "../../lib/extensions/abort-bridge";

describe("abortBridgeFactory", () => {
  it("calls ctx.abort() when the AbortController is aborted after agent_start", () => {
    const handlers = new Map<string, Function>();
    const pi: any = { on: (e: string, h: Function) => handlers.set(e, h), registerTool: () => {} };
    const abort = new AbortController();
    abortBridgeFactory(abort)(pi);
    let aborted = false;
    const ctx = { abort: () => { aborted = true; } };
    handlers.get("agent_start")!({}, ctx);
    abort.abort();
    expect(aborted).toBe(true);
  });

  it("is safe if ctx.abort throws", () => {
    const handlers = new Map<string, Function>();
    const pi: any = { on: (e: string, h: Function) => handlers.set(e, h), registerTool: () => {} };
    const abort = new AbortController();
    abortBridgeFactory(abort)(pi);
    const ctx = { abort: () => { throw new Error("nope"); } };
    handlers.get("agent_start")!({}, ctx);
    expect(() => abort.abort()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/extensions/abort-bridge.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

```ts
// lib/extensions/abort-bridge.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "./types";

export const abortBridgeFactory =
  (abort: AbortController): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    pi.on("agent_start", (_event: any, ctx: any) => {
      const onAbort = () => { try { ctx.abort(); } catch { /* swallow */ } };
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/extensions/abort-bridge.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/extensions/abort-bridge.ts __tests__/extensions/abort-bridge.test.ts
git commit -m "extensions: bridge AbortController to ctx.abort on agent_start"
```

---

## Phase E: Plumbing

### Task 15: Refactor `resolveProfiles` to emit `ExtensionFactory[]`

**Files:**
- Create: `lib/profiles.ts` (lifted out of `lib/runs.ts`)
- Modify: `lib/runs.ts` (remove the inline `PROFILES` block; export `ProfileContext` from the new module)

- [ ] **Step 1: Lift `PROFILES` and `resolveProfiles` to `lib/profiles.ts`**

Create `lib/profiles.ts`:

```ts
// lib/profiles.ts
//
// A profile is a string key that resolves to one or more pi extension
// factories. `toolsProfile` on a run is a comma-separated list of profile
// keys; the runner concatenates the factory lists from each.
//
// 'orchestrator' mounts the task-orchestrator surface (plans, tasks, notes,
// criteria, sessions) via the agent extension.
// 'repo_write' / 'repo_read' are markers for the SDK's built-in fs tools;
// they contribute no factories today (kept for future tightening).
// 'gh_pr', 'gh_ci' mount the GitHub PR / CI helper extensions.
// 'spawn' mounts the child-spawn extension.

import type { ExtensionFactory } from "./extensions/types";
import type { RunRow } from "./runs";

export interface ProfileContext {
  runId: number;
  run: RunRow;
  author: string;
  taskId: string | null;
  cwd: string;
}

interface ProfileDef {
  factories: (ctx: ProfileContext) => Array<ExtensionFactory> | Promise<Array<ExtensionFactory>>;
  allowsRepoWrite?: boolean;
}

const PROFILES: Record<string, ProfileDef> = {
  orchestrator: {
    factories: async (ctx) => {
      const { orchestratorExtension } = await import("./extensions/agent");
      return [orchestratorExtension({
        author: ctx.author,
        defaultTaskId: ctx.taskId ?? undefined,
      })];
    },
  },
  repo_write: { factories: () => [], allowsRepoWrite: true },
  repo_read:  { factories: () => [], allowsRepoWrite: false },
  gh_pr: {
    factories: async (ctx) => {
      const { ghPrExtension } = await import("./extensions/gh-pr");
      return [ghPrExtension({ cwd: ctx.cwd })];
    },
  },
  gh_ci: {
    factories: async (ctx) => {
      const { ghCiExtension } = await import("./extensions/gh-ci");
      return [ghCiExtension({ cwd: ctx.cwd })];
    },
  },
  spawn: {
    factories: async (ctx) => {
      const { spawnExtension } = await import("./extensions/spawn");
      return [spawnExtension({ runId: ctx.runId, runRow: ctx.run })];
    },
  },
};

export interface ResolvedProfile {
  factories: ExtensionFactory[];
  allowsRepoWrite: boolean;
}

export async function resolveProfiles(
  profileString: string,
  ctx: ProfileContext,
): Promise<ResolvedProfile> {
  const names = profileString
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const factories: ExtensionFactory[] = [];
  let allowsRepoWrite = false;
  for (const name of names) {
    const def = PROFILES[name];
    if (!def) throw new Error(`Unknown tools profile: ${name}`);
    const got = await def.factories(ctx);
    factories.push(...got);
    if (def.allowsRepoWrite) allowsRepoWrite = true;
  }
  return { factories, allowsRepoWrite };
}
```

- [ ] **Step 2: Remove the inline `PROFILES` and `resolveProfiles` from `lib/runs.ts`**

In `lib/runs.ts`, delete lines 202–end-of-`resolveProfiles` (the block bounded by the `// Tool profile registry` comment and the `async function resolveProfiles(...)` definition). Then add at the top of the file:

```ts
import { resolveProfiles, type ProfileContext } from "./profiles";
```

Remove the local `ProfileContext` interface (now imported). Remove the local `McpServerFactory` and `ProfileDef` types.

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: still failing on the old `sdk.query()` block in `runOneTurn` and the `resolveProfiles` call site (now returns `factories` not `servers`). That's OK — Task 17 fixes both.

- [ ] **Step 4: Commit**

```bash
git add lib/profiles.ts lib/runs.ts
git commit -m "profiles: lift PROFILES into lib/profiles.ts; emit ExtensionFactory[]"
```

---

### Task 16: Pi → RunEnvelope event mapper

**Files:**
- Create: `lib/pi-event-mapper.ts`
- Test: `__tests__/pi-event-mapper.test.ts`

- [ ] **Step 1: Define the envelope type**

The current `SdkMessageEnvelope` type lives inside `lib/runs.ts`. Lift its shape into `lib/pi-event-mapper.ts` so both files can import it:

```ts
// lib/pi-event-mapper.ts
//
// Translate pi.dev session events into the internal RunEnvelope shape used
// by lib/runs.ts (persistence, the run-bus SSE stream, and the UI). Keeping
// the envelope shape stable means downstream code is untouched by the SDK
// swap.

export interface RunEnvelopeContentBlock {
  type: string;
  text?: string;
  // (other SDK-specific fields are passed through opaquely)
  [k: string]: unknown;
}

export type RunEnvelope =
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "assistant"; message: { content: RunEnvelopeContentBlock[] } }
  | { type: "user"; message: { content: RunEnvelopeContentBlock[] } }
  | {
      type: "result";
      result: string | null;
      is_error?: boolean;
      total_cost_usd: number | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    }
  | { type: "stream_text"; text: string }
  | { type: "stream_thinking"; text: string };

interface SessionLite {
  // not used today, but kept on the signature for future event-shape extensions
}
interface SessionManagerLite {
  getSessionFile(): string | undefined;
}

/**
 * Map a single pi event to zero or more RunEnvelope rows. Returns [] for
 * events that don't have an envelope equivalent (e.g. low-level lifecycle
 * the runner doesn't surface to consumers).
 */
export function mapPiEvent(
  ev: any,
  _session: SessionLite,
  sessionManager: SessionManagerLite
): RunEnvelope[] {
  switch (ev.type) {
    case "agent_start": {
      const file = sessionManager.getSessionFile();
      if (!file) return [];
      return [{ type: "system", subtype: "init", session_id: file }];
    }
    case "message_end": {
      const content = (ev.message?.content as RunEnvelopeContentBlock[] | undefined) ?? [];
      if (content.length === 0) return [];
      return [{ type: "assistant", message: { content } }];
    }
    case "tool_execution_end": {
      const block: RunEnvelopeContentBlock = {
        type: "tool_result",
        tool_use_id: ev.toolCallId,
        content: ev.result?.content ?? [],
        is_error: ev.isError === true,
      };
      return [{ type: "user", message: { content: [block] } }];
    }
    case "agent_end": {
      const messages = ev.messages as Array<{ content?: RunEnvelopeContentBlock[] }> | undefined;
      const lastText = extractLastText(messages);
      const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return [{
        type: "result",
        result: lastText,
        is_error: false,
        total_cost_usd: null, // pi does not surface cost
        usage,
      }];
    }
    case "message_update": {
      const sub = ev.assistantMessageEvent;
      if (sub?.type === "text_delta" && typeof sub.delta === "string") {
        return [{ type: "stream_text", text: sub.delta }];
      }
      if (sub?.type === "thinking_delta" && typeof sub.delta === "string") {
        return [{ type: "stream_thinking", text: sub.delta }];
      }
      return [];
    }
    default:
      return [];
  }
}

function extractLastText(
  messages: Array<{ content?: RunEnvelopeContentBlock[] }> | undefined
): string | null {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = (m.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}
```

- [ ] **Step 2: Write the failing tests**

Create `__tests__/pi-event-mapper.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapPiEvent } from "../lib/pi-event-mapper";

const sm = (file: string | undefined) => ({ getSessionFile: () => file });

describe("mapPiEvent", () => {
  it("agent_start emits a system/init envelope with the session file path", () => {
    const got = mapPiEvent({ type: "agent_start" }, {}, sm("/p/.pi/sessions/abc.jsonl"));
    expect(got).toEqual([{
      type: "system", subtype: "init",
      session_id: "/p/.pi/sessions/abc.jsonl",
    }]);
  });

  it("agent_start with no session file emits nothing", () => {
    expect(mapPiEvent({ type: "agent_start" }, {}, sm(undefined))).toEqual([]);
  });

  it("message_end with content emits an assistant envelope", () => {
    const got = mapPiEvent(
      { type: "message_end", message: { content: [{ type: "text", text: "hi" }] } },
      {}, sm("/x")
    );
    expect(got).toEqual([{
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    }]);
  });

  it("message_end with empty content emits nothing", () => {
    expect(mapPiEvent(
      { type: "message_end", message: { content: [] } }, {}, sm("/x")
    )).toEqual([]);
  });

  it("tool_execution_end emits a user/tool_result envelope", () => {
    const got = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    }, {}, sm("/x"));
    expect(got).toEqual([{
      type: "user",
      message: { content: [{
        type: "tool_result", tool_use_id: "tc-1",
        content: [{ type: "text", text: "ok" }], is_error: false,
      }] },
    }]);
  });

  it("agent_end emits a result envelope with last assistant text and tokens", () => {
    const got = mapPiEvent({
      type: "agent_end",
      messages: [
        { content: [{ type: "text", text: "first" }] },
        { content: [{ type: "text", text: "final" }] },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    }, {}, sm("/x"));
    expect(got).toEqual([{
      type: "result",
      result: "final",
      is_error: false,
      total_cost_usd: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }]);
  });

  it("message_update text_delta emits a stream_text envelope", () => {
    const got = mapPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ab" } },
      {}, sm("/x")
    );
    expect(got).toEqual([{ type: "stream_text", text: "ab" }]);
  });

  it("unknown event types map to nothing", () => {
    expect(mapPiEvent({ type: "queue_update" }, {}, sm("/x"))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run __tests__/pi-event-mapper.test.ts`
Expected: all eight tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/pi-event-mapper.ts __tests__/pi-event-mapper.test.ts
git commit -m "lib: pi event → RunEnvelope mapper"
```

---

## Phase F: Core rewrite

### Task 17: Rewrite `runOneTurn` against the pi SDK

**Files:**
- Modify: `lib/runs.ts` (rewrite `runOneTurn`; thread `personaId` through `RunRow`, `CreateRunInput`, `runs.create`; switch envelope type to `RunEnvelope` from the new mapper)
- Modify: `db/schema.ts` is already done (Task 1)
- Delete: `lib/gh-pr-mcp.ts`, `lib/gh-ci-mcp.ts`, `lib/spawn-mcp.ts`, `lib/agent-mcp.ts`

- [ ] **Step 1: Add `personaId` to `RunRow`, `CreateRunInput`, `runs.create`**

In `lib/runs.ts`, find:
- The `RunRow` interface (around line 105) — add `personaId: string | null;`
- The `CreateRunInput` interface (around line 74) — add `personaId?: string | null;`
- The `runs.create` body — set `personaId: input.personaId ?? "implementor"` on the insert (default to implementor when caller doesn't specify; the persona must already exist in the personas table or the FK fails — this is fine because we seed at boot).

Update the row-mapping functions (`rowToRun` around line 1175 and the messages mapper around 1206) to read `row.personaId`.

- [ ] **Step 2: Replace the imports at the top of `lib/runs.ts`**

Remove:
```ts
// (the dynamic import inside runOneTurn — see lines 973-976)
```

Add at the top:

```ts
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  getModel,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { mapPiEvent, type RunEnvelope } from "./pi-event-mapper";
import { sandboxFactory } from "./extensions/sandbox";
import { personaPromptFactory } from "./extensions/persona-prompt";
import { personaMemoryFactory } from "./extensions/persona-memory";
import { abortBridgeFactory } from "./extensions/abort-bridge";
```

Replace any remaining type references to `SdkMessageEnvelope` with `RunEnvelope`.

- [ ] **Step 3: Rewrite `runOneTurn`**

Replace the body of `async function runOneTurn(args: RunOneTurnArgs): Promise<TurnResult>` (currently lines 970–1074) with:

```ts
async function runOneTurn(args: RunOneTurnArgs): Promise<TurnResult> {
  const { run, cwd, prompt, abort, author, onSdk } = args;

  const persona = repo.getPersona(run.personaId ?? "implementor");
  if (!persona) {
    throw new Error(
      `Persona '${run.personaId ?? "implementor"}' not found; ` +
      `seed personas via db/seed-personas.ts.`
    );
  }

  const modelId = run.model ?? persona.modelId;
  const profileSpec = run.toolsProfile ?? persona.toolsProfile;

  const profileCtx: ProfileContext = {
    runId: run.id, run, author, taskId: run.taskId, cwd,
  };
  const { factories: profileFactories } = await resolveProfiles(profileSpec, profileCtx);

  const sandboxDbPath = sandboxDbPathFor(run, cwd);
  const personaForExt = {
    id: persona.id,
    name: persona.name,
    description: persona.description ?? "",
    systemPrompt: persona.systemPrompt,
    model: { provider: persona.modelProvider, id: persona.modelId },
    thinkingLevel: (persona.thinkingLevel ?? undefined) as "low" | "medium" | "high" | undefined,
    toolsProfile: persona.toolsProfile,
    skillPaths: JSON.parse(persona.skillPaths) as string[],
  };

  const factories = [
    personaPromptFactory(personaForExt),
    personaMemoryFactory(personaForExt, run, repo, cwd),
    sandboxFactory(cwd, sandboxDbPath),
    abortBridgeFactory(abort),
    ...profileFactories,
  ];

  const sessionDir = path.join(cwd, ".pi", "sessions");
  const sessionManager = run.sdkSessionId
    ? SessionManager.open(run.sdkSessionId, sessionDir)
    : SessionManager.create(cwd, sessionDir);

  const authStorage = AuthStorage.create();
  const { session } = await createAgentSession({
    cwd,
    model: getModel(persona.modelProvider, modelId),
    thinkingLevel: persona.thinkingLevel ?? undefined,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage),
    sessionManager,
    resourceLoader: new DefaultResourceLoader({
      extensionFactories: factories,
      additionalSkillPaths: personaForExt.skillPaths.map((p) => path.resolve(cwd, p)),
    }),
  });

  const envelopes: RunEnvelope[] = [];
  const assistantBlocks: any[] = [];
  let summary: string | null = null;
  let lastAssistantText: string | null = null;
  let sdkSessionId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let turns = 0;

  let agentEndResolve: () => void;
  const agentEndPromise = new Promise<void>((res) => { agentEndResolve = res; });

  const stop = session.subscribe((rawEv: any) => {
    if (abort.signal.aborted) return;

    if (rawEv.type === "turn_end") turns += 1;

    for (const env of mapPiEvent(rawEv, session, sessionManager)) {
      envelopes.push(env);
      onSdk?.(env as any);

      if (env.type === "system" && env.subtype === "init" && env.session_id) {
        sdkSessionId = env.session_id;
        db.update(agentSessions)
          .set({ sdkSessionId })
          .where(eq(agentSessions.id, run.id))
          .run();
      }

      if (env.type === "assistant" && env.message?.content) {
        for (const b of env.message.content) assistantBlocks.push(b);
        const text = env.message.content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => (b as any).text)
          .join("\n").trim();
        if (text) lastAssistantText = text;
      }

      if (env.type === "user" && env.message?.content) {
        const toolResults = env.message.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) persistMessage(run.id, "tool", toolResults as any);
      }

      if (env.type === "result") {
        if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
        inputTokens = env.usage?.input_tokens ?? inputTokens;
        outputTokens = env.usage?.output_tokens ?? outputTokens;
      }
    }

    if (rawEv.type === "agent_end") agentEndResolve();
  });

  try {
    await session.prompt(prompt);
    await Promise.race([
      agentEndPromise,
      new Promise<void>((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      ),
    ]);
  } finally {
    stop();
  }

  if (assistantBlocks.length > 0) {
    persistMessage(run.id, "agent", assistantBlocks as any);
  }

  return {
    envelopes: envelopes as any,
    summary: summary ?? lastAssistantText,
    sdkSessionId,
    totalCostUsd: null,
    inputTokens,
    outputTokens,
    turns,
  };
}
```

- [ ] **Step 4: Drop USD enforcement in `checkBudget`**

Find `function checkBudget(run: RunRow, result: TurnResult): boolean` (around line 1076). Remove the `budgetMaxUsd` branch (or short-circuit it):

```ts
function checkBudget(run: RunRow, result: TurnResult): boolean {
  if (run.budgetMaxTurns != null && result.turns >= run.budgetMaxTurns) return true;
  // budgetMaxUsd not enforced under pi (no total_cost_usd surface);
  // column kept for historical data (see SCHEMA.md).
  return false;
}
```

- [ ] **Step 5: Delete the old MCP server files**

```bash
git rm lib/gh-pr-mcp.ts lib/gh-ci-mcp.ts lib/spawn-mcp.ts lib/agent-mcp.ts
```

If any other file in the codebase still imports these, fix the import to `lib/extensions/<name>` and update the named export. Find them with:

```bash
grep -rn "from \"@/lib/gh-pr-mcp\"\|from \"@/lib/gh-ci-mcp\"\|from \"@/lib/spawn-mcp\"\|from \"@/lib/agent-mcp\"\|from \"./gh-pr-mcp\"\|from \"./gh-ci-mcp\"\|from \"./spawn-mcp\"\|from \"./agent-mcp\"" .
```

(`gh-url` re-exports stay because those are still in `lib/gh-url.ts`.)

- [ ] **Step 6: Update `SCHEMA.md`**

In `SCHEMA.md`, find the `agent_sessions` block and:
- Update the `total_cost_usd` line: append " — populated only on legacy (pre-pi) rows; not enforced post-cutover."
- Update the `sdk_session_id` line: replace with " — pi.dev: absolute path to the JSONL session file under `<cwd>/.pi/sessions/`. Used to resume."
- Add a new line: `persona_id  TEXT  FK → personas.id ON DELETE SET NULL  default 'implementor'`
- Add a `personas` block describing the new table (see migration for fields).
- Add a `persona_memories` block describing the new table.

- [ ] **Step 7: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck passes; existing tests pass except for any that imported from the old MCP module paths (those should already be moved/updated by Tasks 7–10).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "runs: rewrite runOneTurn against pi.dev SDK; drop USD budgets"
```

---

## Phase G: UI

### Task 18: `GET /api/personas`

**Files:**
- Create: `app/api/personas/route.ts`
- Test: `__tests__/personas-api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/personas-api.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { GET } from "../app/api/personas/route";
import { db } from "../db";
import { personas as personasTable } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";

describe("GET /api/personas", () => {
  beforeEach(() => {
    db.delete(personasTable).run();
    seedPersonas();
  });

  it("returns all seeded personas with the expected shape", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.personas.length).toBe(5);
    const r = body.personas.find((p: any) => p.id === "reviewer");
    expect(r).toMatchObject({
      id: "reviewer",
      name: "Reviewer",
      modelProvider: "anthropic",
      modelId: "claude-opus-4-5",
    });
    expect(Array.isArray(r.skillPaths)).toBe(true);
  });
});
```

- [ ] **Step 2: Implement the route**

```ts
// app/api/personas/route.ts
import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export async function GET() {
  const personas = repo.listPersonas().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    systemPrompt: p.systemPrompt,
    modelProvider: p.modelProvider,
    modelId: p.modelId,
    thinkingLevel: p.thinkingLevel,
    toolsProfile: p.toolsProfile,
    skillPaths: JSON.parse(p.skillPaths) as string[],
    budgetMaxTurns: p.budgetMaxTurns,
    budgetMaxSeconds: p.budgetMaxSeconds,
  }));
  return NextResponse.json({ personas });
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run __tests__/personas-api.test.ts`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add app/api/personas/route.ts __tests__/personas-api.test.ts
git commit -m "api: GET /api/personas"
```

---

### Task 19: Read-only `/personas` page

**Files:**
- Create: `app/personas/page.tsx`

- [ ] **Step 1: Implement the page**

```tsx
// app/personas/page.tsx
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export default function PersonasPage() {
  const personas = repo.listPersonas();
  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Personas</h1>
      <p className="text-sm text-muted-foreground">
        Personas bundle (system prompt, model, tools, skills, budgets) per role.
        Edit <code>lib/personas/*.ts</code> and restart to change them.
      </p>
      <ul className="space-y-4">
        {personas.map((p) => {
          const skillPaths = JSON.parse(p.skillPaths) as string[];
          return (
            <li key={p.id} className="rounded border p-4 space-y-2">
              <div className="flex items-baseline gap-3">
                <h2 className="text-lg font-medium">{p.name}</h2>
                <code className="text-xs">{p.id}</code>
              </div>
              {p.description && (
                <p className="text-sm">{p.description}</p>
              )}
              <dl className="grid grid-cols-[8rem_1fr] gap-1 text-sm">
                <dt className="text-muted-foreground">Model</dt>
                <dd>{p.modelProvider}/{p.modelId}{p.thinkingLevel ? ` (thinking: ${p.thinkingLevel})` : ""}</dd>
                <dt className="text-muted-foreground">Tools</dt>
                <dd><code>{p.toolsProfile}</code></dd>
                <dt className="text-muted-foreground">Skills</dt>
                <dd>
                  {skillPaths.length === 0 ? "—" : skillPaths.map((s) => (
                    <code key={s} className="block">{s}</code>
                  ))}
                </dd>
                <dt className="text-muted-foreground">Budget</dt>
                <dd>
                  turns: {p.budgetMaxTurns ?? "—"}, seconds: {p.budgetMaxSeconds ?? "—"}
                </dd>
              </dl>
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">System prompt</summary>
                <pre className="whitespace-pre-wrap text-xs mt-2">{p.systemPrompt}</pre>
              </details>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
```

- [ ] **Step 2: Verify the page renders**

Run: `npm run dev` (background)
Then: `curl -s http://localhost:3000/personas | head -20`
Expected: HTML containing "Personas" heading and at least the five persona ids.

- [ ] **Step 3: Commit**

```bash
git add app/personas/page.tsx
git commit -m "ui: read-only /personas listing"
```

---

### Task 20: Persona picker on task creation and chat composer

**Files:**
- Modify: existing task-create form (find with: `grep -rn "new task\|createTask\|task.create" app/ components/ | head -20`)
- Modify: existing chat composer / new-run dialog (find with: `grep -rn "createRun\|new run\|tools_profile" app/ components/ | head -20`)

- [ ] **Step 1: Identify the affected components**

Run the two grep commands above. The forms that today let the user pick `assignee` and/or `toolsProfile` need an additional `<select>` populated from `GET /api/personas`. Most likely files:
- A task creation form somewhere under `app/tasks/`
- The chat composer in `components/chat/` or similar

For each form, locate the JSX block that contains the existing `assignee` or `toolsProfile` field. The persona picker goes alongside.

- [ ] **Step 2: Add the persona picker (server-component variant)**

For server components, fetch via `repo.listPersonas()` directly. Example block to insert:

```tsx
{/* Persona picker */}
<label className="block">
  <span className="text-sm font-medium">Persona</span>
  <select
    name="personaId"
    defaultValue="implementor"
    className="mt-1 block w-full rounded border px-2 py-1"
  >
    {personas.map((p) => (
      <option key={p.id} value={p.id}>
        {p.name} — {p.modelProvider}/{p.modelId}
      </option>
    ))}
  </select>
</label>
```

Where `personas` comes from a server-side `repo.listPersonas()` call at the top of the component.

- [ ] **Step 3: Wire the form submission**

Wherever the form posts to `runs.create()` (directly or via an API route), add `personaId: formData.get("personaId") as string` to the input. The runner now defaults to `"implementor"` if `personaId` is omitted, so old callers keep working — but explicitly threading it makes the picker meaningful.

- [ ] **Step 4: Update the run-detail page header**

Find the run detail page (likely `app/runs/[id]/page.tsx`). In the header, where it currently shows `model`, also show the persona name. Pull `repo.getPersona(run.personaId)` once and render `${persona.name} · ${run.model ?? persona.modelId}`.

- [ ] **Step 5: Manual smoke**

Open the task creation form in a browser, confirm:
- Persona dropdown shows all 5 entries.
- Selecting "Reviewer" then submitting creates a run; the run detail page header shows "Reviewer · anthropic/claude-opus-4-5".

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "ui: persona picker on task create + chat; show persona in run header"
```

---

## Phase H: Smoke

### Task 21: End-to-end smoke run

- [ ] **Step 1: Start fresh DB and server**

Run:
```bash
rm -f data.db
npm run db:seed
npm run dev &
```

- [ ] **Step 2: Confirm personas seeded**

```bash
curl -s http://localhost:3000/api/personas | jq '.personas | length'
```
Expected: `5`.

- [ ] **Step 3: Run an implementor task**

Create a throwaway task targeting a worktree-safe goal (e.g. "Add a comment to README.md explaining the personas table"). Trigger a run with `persona=implementor`. Watch the run detail page stream:
- Streaming text deltas appear in real time.
- Tool calls are persisted (`agent_messages` row with `role=tool`).
- The `agent_runs` row gets `sdk_session_id` populated with a `.pi/sessions/...jsonl` path.
- The run reaches `completed`.

- [ ] **Step 4: Resume the run**

Append a message to the same run (via the chat composer). Confirm:
- A second turn fires.
- `SessionManager.open(...)` reads back the JSONL file (verify with `ls .worktrees/<worktree>/.pi/sessions/`).
- The new turn's events stream as expected.

- [ ] **Step 5: Run a reviewer task**

Trigger a run with `persona=reviewer` against an existing PR URL. Confirm:
- The reviewer model (Opus) is used (visible in run header).
- `gh_pr__pr_view` and `gh_pr__pr_diff` tools are called.
- The run posts a review via `gh_pr__pr_review` and reaches `completed`.

- [ ] **Step 6: Test memory persistence**

In the implementor run, send a message asking the agent to use `memory_remember` with scope `global` and a note like "always run npm typecheck before committing".

After the run completes, start a new implementor run on a different task. Confirm the new run's `<cwd>/.pi/skills/persona-memory-implementor/SKILL.md` includes the remembered note.

- [ ] **Step 7: Sandbox verification**

In a run, ask the agent to write a file to `/tmp/escape.txt`. Confirm:
- The `tool_call` is blocked (visible in stream as a tool error).
- No `/tmp/escape.txt` exists on the host (`ls /tmp/escape.txt` → not found).

- [ ] **Step 8: Commit any docs / smoke fixes**

If any small documentation updates fell out (e.g. typos in `SCHEMA.md`), commit them now:

```bash
git add -A
git commit -m "docs: smoke-pass cleanups"
```

- [ ] **Step 9: Open the PR**

```bash
git push -u origin <branch-name>
gh pr create --title "Migrate to pi.dev SDK; introduce agent personas" --body "$(cat <<'EOF'
## Summary
- Hard cutover from @anthropic-ai/claude-agent-sdk to @earendil-works/pi-coding-agent.
- New persona model (reviewer, implementor, planner, designer, qa) bundling system prompt, model, tools, skills, memory, budgets.
- Pi extensions replace the four MCP servers; new extensions add filesystem sandbox, persona prompt, persona memory, abort bridge.
- Per-run `persona_id` selects the bundle; per-run `model`/`tools_profile` still override.
- USD budget enforcement removed (pi does not surface total_cost_usd).

## Test plan
- [x] Unit tests pass (vitest)
- [x] Implementor smoke run completes against a throwaway worktree
- [x] Reviewer smoke run posts a PR review
- [x] Memory persists across runs at global scope
- [x] Sandbox blocks writes outside cwd

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Done

When Task 21 is green and the PR is up, the migration is complete. Check:
- Five personas in the `personas` table.
- `agent_runs.persona_id` populated on new runs.
- `agent_runs.sdk_session_id` holds JSONL paths for new runs.
- No imports of `@anthropic-ai/claude-agent-sdk` anywhere (`grep -r "@anthropic-ai/claude-agent-sdk" .`).
- No imports of `lib/gh-pr-mcp` / `lib/gh-ci-mcp` / `lib/spawn-mcp` / `lib/agent-mcp` (`grep -r "-mcp\"" .`).
