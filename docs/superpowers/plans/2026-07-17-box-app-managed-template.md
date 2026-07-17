# App-Managed Box Template Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ensureTemplate()` — the app builds a Box template lazily when none matches the current worker build SHA, defers the triggering run with the already-shipped live feedback, then forks run boxes from the ready template.

**Architecture:** A `box_templates` registry table is the single-flight lock (partial unique index on `worker_sha` for live rows). `resolveBoxTemplate()` decides pinned/ready/building and kicks off `runBoxTemplateBuild()` (fire-and-forget in the server process), which drives the build over `BoxClient.command` wrapped in the existing `emitTemplateBuildLifecycle` driver so all feedback lands for free. `BoxRunnerProvider.admit()` gains a template gate whose defer reasons flow into `pending_reason`.

**Tech Stack:** Drizzle/Postgres, structural `BoxClient` fakes for tests (pattern: `__tests__/box-provider-e2e.test.ts`), vitest (node env).

**Spec:** `docs/superpowers/specs/2026-07-17-box-app-managed-template-design.md` — read it first. The feedback half already landed (`lib/runner/box-template-events.ts`, `pending_reason`, stepper).

## Global Constraints

- Defer reason strings (verbatim): `"Building box template…"` (builder run) and `` `Waiting for box template build (started by run #${builderRunId})` `` (other runs).
- Step names in build order: `cloning-worker`, `installing-deps`, `building-worker`, `cloning-agent-repo`, `installing-agent-deps`, `writing-manifest`, `archiving`.
- New env keys: `TASK_ORCH_BOX_WORKER_REPO_URL` (default `https://github.com/nodetool-ai/task-orchestrator.git`), `TASK_ORCH_BOX_WORKER_REPO_REF` (default `main`), `TASK_ORCH_BOX_AGENT_REPO_URL` (default `https://github.com/nodetool-ai/nodetool.git`), `TASK_ORCH_BOX_AGENT_REPO` (default `nodetool-ai/nodetool`), `TASK_ORCH_BOX_BUILD_STEP_TIMEOUT_S` (default `900`), `TASK_ORCH_WORKER_SHA`. **No base-box env key** — the build creates its own blank box.
- App-managed provisioning is the DEFAULT: `BOX_API_KEY` alone enables it. A pinned `TASK_ORCH_BOX_TEMPLATE_ID` disables it entirely (registry untouched).
- The blank box is created fresh via `BoxClient.create({ env: {}, noEnv: true })` (SDK `POST /boxes`). There is no operator-provided base box anywhere.
- Never stage/commit the unrelated dirty files: `scripts/worker-chat.ts`, `__tests__/worker-chat-box.test.ts`. (`BOX_TEMPLATE_UI_FEEDBACK_GAP.md` is committed ONLY by Task 7, which owns closing it.)
- If `git commit` fails with an index.lock error, wait 2s and retry (up to 5×).
- Tests: `npx vitest run <file>`; typecheck: `npm run typecheck`.

---

### Task 1: `workerBuildSha()` source

**Files:**
- Create: `lib/runner/worker-sha.ts`
- Test: `__tests__/worker-sha.test.ts`

**Interfaces:**
- Produces: `workerBuildSha(opts?): Promise<string>`, `resetWorkerShaCache(): void` (test hook). Consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/worker-sha.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { resetWorkerShaCache, workerBuildSha } from "../lib/runner/worker-sha";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_SHA;
  resetWorkerShaCache();
});

describe("workerBuildSha", () => {
  it("prefers the TASK_ORCH_WORKER_SHA override", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "a".repeat(40);
    await expect(workerBuildSha()).resolves.toBe("a".repeat(40));
  });

  it("rejects a malformed override", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "not-a-sha";
    await expect(workerBuildSha()).rejects.toThrow(/TASK_ORCH_WORKER_SHA/);
  });

  it("falls back to git rev-parse HEAD and caches it", async () => {
    // The test process runs inside this repository, so git is available.
    const first = await workerBuildSha();
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    const second = await workerBuildSha({
      exec: async () => {
        throw new Error("must not re-exec once cached");
      },
    });
    expect(second).toBe(first);
  });

  it("throws a clear error when git is unavailable and no override is set", async () => {
    resetWorkerShaCache();
    await expect(
      workerBuildSha({ exec: async () => { throw new Error("git: not found"); } })
    ).rejects.toThrow(/TASK_ORCH_WORKER_SHA/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/worker-sha.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

```ts
// lib/runner/worker-sha.ts
//
// The worker build SHA that identifies which worker code a Box template must
// contain. Env override first (deployed control planes can be git-less), else
// `git rev-parse HEAD` in the server checkout, cached per process.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
const defaultExec: Exec = (cmd, args) => execFileAsync(cmd, args);

let cached: string | undefined;

export function resetWorkerShaCache(): void {
  cached = undefined;
}

export async function workerBuildSha(opts: { exec?: Exec } = {}): Promise<string> {
  const override = process.env.TASK_ORCH_WORKER_SHA?.trim();
  if (override) {
    if (!SHA.test(override)) {
      throw new Error("TASK_ORCH_WORKER_SHA must be a 40-character lowercase git SHA.");
    }
    return override;
  }
  if (cached) return cached;
  try {
    const { stdout } = await (opts.exec ?? defaultExec)("git", ["rev-parse", "HEAD"]);
    const sha = stdout.trim();
    if (!SHA.test(sha)) throw new Error(`git rev-parse returned "${sha}"`);
    cached = sha;
    return sha;
  } catch (error) {
    throw new Error(
      `Cannot determine the worker build SHA (git failed: ${error instanceof Error ? error.message : String(error)}). ` +
        "Set TASK_ORCH_WORKER_SHA on git-less deployments."
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/worker-sha.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/worker-sha.ts __tests__/worker-sha.test.ts
git commit -m "feat(box-template): worker build SHA source with env override"
```

---

### Task 2: `box_templates` registry table

**Files:**
- Create: `db/migrations/0020_box_templates.sql`
- Modify: `db/migrations/meta/_journal.json` (append entry idx 20)
- Modify: `db/schema.ts` (new table after `runnerInstances`)
- Test: `__tests__/box-template-registry.test.ts` (schema smoke only; the registry logic tests arrive in Task 4)

**Interfaces:**
- Produces: `boxTemplates` drizzle table (Tasks 4, 6, 7 consume).

- [ ] **Step 1: Migration**

```sql
-- db/migrations/0020_box_templates.sql
-- App-managed Box template registry (spec 2026-07-17-box-app-managed-template).
-- The partial unique index is the single-flight lock: at most one live
-- (building/ready) template per worker SHA.
CREATE TABLE IF NOT EXISTS "box_templates" (
  "id" serial PRIMARY KEY,
  "worker_sha" text NOT NULL,
  "repository" text NOT NULL,
  "state" text NOT NULL DEFAULT 'building',
  "box_id" text,
  "triggering_run_id" integer,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ready_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "box_templates_live_sha_idx"
  ON "box_templates" ("worker_sha")
  WHERE "state" IN ('building', 'ready');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "box_templates_state_idx" ON "box_templates" ("state");
```

Journal entry (after idx 19):

```json
    {
      "idx": 20,
      "version": "7",
      "when": 1784660000000,
      "tag": "0020_box_templates",
      "breakpoints": true
    }
```

- [ ] **Step 2: Schema**

Add to `db/schema.ts` after the `runnerInstances` table (match the file's `ts()` timestamp helper and comment style):

```ts
// App-managed Box template registry (docs/superpowers/specs/
// 2026-07-17-box-app-managed-template-design.md). One live row per worker
// SHA enforced by a partial unique index — the build single-flight lock.
export const boxTemplates = pgTable(
  "box_templates",
  {
    id: serial("id").primaryKey(),
    workerSha: text("worker_sha").notNull(),
    repository: text("repository").notNull(),
    // building → ready | failed; ready → superseded when a newer SHA lands.
    state: text("state").notNull().default("building"),
    boxId: text("box_id"),
    // The run whose dispatch started this build — template lifecycle events
    // are emitted against it.
    triggeringRunId: integer("triggering_run_id"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    readyAt: ts("ready_at"),
  },
  (t) => ({
    liveShaIdx: uniqueIndex("box_templates_live_sha_idx")
      .on(t.workerSha)
      .where(sql`${t.state} IN ('building', 'ready')`),
    stateIdx: index("box_templates_state_idx").on(t.state),
  })
);
```

(`uniqueIndex`, `index`, `sql`, `serial`, `integer`, `text` are already imported in the file — verify and extend the import if `serial`/`uniqueIndex` are missing.)

- [ ] **Step 3: Write the failing smoke test**

```ts
// __tests__/box-template-registry.test.ts
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { boxTemplates } from "../db/schema";

describe("box_templates schema", () => {
  it("inserts a building row and enforces one live row per sha", async () => {
    const sha = "f".repeat(39) + "1";
    const [row] = await db
      .insert(boxTemplates)
      .values({ workerSha: sha, repository: "nodetool-ai/nodetool", triggeringRunId: 1 })
      .returning();
    expect(row.state).toBe("building");
    await expect(
      db.insert(boxTemplates).values({ workerSha: sha, repository: "nodetool-ai/nodetool" })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run test — fails before the schema lands, passes after**

Run: `npx vitest run __tests__/box-template-registry.test.ts`
Expected: PASS once migration + schema are in (migrations apply automatically per test fork via `vitest.setup`'s `initDb`).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add db/migrations/0020_box_templates.sql db/migrations/meta/_journal.json db/schema.ts __tests__/box-template-registry.test.ts
git commit -m "feat(box-template): box_templates registry table with single-flight index"
```

---

### Task 3: Config keys + validation

**Files:**
- Modify: `lib/config.ts` (the `box:` block ~line 390, `validateBoxConfig` ~line 453)
- Test: `__tests__/config.test.ts` (append) — and check `__tests__/config-guard.test.ts`'s allowlist conventions: new `TASK_ORCH_*` reads inside `lib/config.ts` are the sanctioned location, so no allowlist change should be needed.

**Interfaces:**
- Produces (Tasks 4, 5 consume): `config.box.workerRepoUrl`, `.workerRepoRef`, `.agentRepoUrl`, `.agentRepo`, `.buildStepTimeoutSeconds`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/config.test.ts` (follow the file's existing env save/restore pattern):

```ts
describe("box app-managed template config", () => {
  it("exposes defaults for the template build settings", () => {
    expect(config.box.workerRepoUrl).toBe("https://github.com/nodetool-ai/task-orchestrator.git");
    expect(config.box.workerRepoRef).toBe("main");
    expect(config.box.agentRepoUrl).toBe("https://github.com/nodetool-ai/nodetool.git");
    expect(config.box.agentRepo).toBe("nodetool-ai/nodetool");
    expect(config.box.buildStepTimeoutSeconds).toBe(900);
  });

  it("validateBoxConfig requires only BOX_API_KEY (app-managed is the default)", () => {
    process.env.TASK_ORCH_RUNNER = "box";
    delete process.env.TASK_ORCH_BOX_TEMPLATE_ID;
    delete process.env.BOX_API_KEY;
    expect(() => validateBoxConfig()).toThrow(/BOX_API_KEY/);
    process.env.BOX_API_KEY = "test-key";
    expect(() => validateBoxConfig()).not.toThrow(); // no template id and no base id needed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/config.test.ts`
Expected: FAIL — new getters missing.

- [ ] **Step 3: Implement**

In the `box:` block of `lib/config.ts`, after `repoPath`:

```ts
    get workerRepoUrl(): string {
      return strEnv("TASK_ORCH_BOX_WORKER_REPO_URL", "https://github.com/nodetool-ai/task-orchestrator.git");
    },
    get workerRepoRef(): string {
      return strEnv("TASK_ORCH_BOX_WORKER_REPO_REF", "main");
    },
    get agentRepoUrl(): string {
      return strEnv("TASK_ORCH_BOX_AGENT_REPO_URL", "https://github.com/nodetool-ai/nodetool.git");
    },
    get agentRepo(): string {
      return strEnv("TASK_ORCH_BOX_AGENT_REPO", "nodetool-ai/nodetool");
    },
    /** Per-step budget for template build commands (npm ci can take minutes). */
    get buildStepTimeoutSeconds(): number {
      return intEnv("TASK_ORCH_BOX_BUILD_STEP_TIMEOUT_S", 900);
    },
```

In `validateBoxConfig()`, DELETE the block that throws when
`TASK_ORCH_BOX_TEMPLATE_ID` is unset (the `if (!config.box.templateId) throw …`
lines). App-managed provisioning is the default; the `BOX_API_KEY` check above
it stays and is now the only hard requirement. A pin remains optional.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run __tests__/config.test.ts __tests__/config-guard.test.ts && npm run typecheck`
Expected: config tests PASS. NOTE: `config-guard.test.ts` currently fails because of the pre-existing uncommitted `scripts/worker-chat.ts` working-tree change (unrelated); it must not fail because of *your* changes — new env reads live in `lib/config.ts`, which is the sanctioned location.

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts __tests__/config.test.ts
git commit -m "feat(config): app-managed Box template build settings"
```

---

### Task 4: Registry — resolve, single-flight, supersede

**Files:**
- Create: `lib/runner/box-template-registry.ts`
- Modify: `__tests__/box-template-registry.test.ts` (extend)

**Interfaces:**
- Consumes: `boxTemplates` (T2), `workerBuildSha` (T1), `config.box.templateId` / `.agentRepo` / `.buildStepTimeoutSeconds` (T3).
- Produces (Tasks 5, 6 consume):

```ts
type TemplateResolution =
  | { kind: "pinned"; boxId: string }
  | { kind: "ready"; boxId: string; workerSha: string }
  | { kind: "building"; builderRunId: number | null; registryId: number; startedNow: boolean };
resolveBoxTemplate(input: { runId: number }): Promise<TemplateResolution>
markTemplateReady(registryId: number, boxId: string): Promise<void>
markTemplateFailed(registryId: number, error: string): Promise<void>
/** Injectable build kickoff — resolveBoxTemplate calls this when its insert wins. */
setTemplateBuildStarter(fn: ((row: { registryId: number; runId: number; workerSha: string }) => void) | null): void
```

The build starter is an injectable module-level hook (default: a no-op that logs a warning) so the registry has no import cycle with the builder; Task 6 wires the real starter at provider construction.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/box-template-registry.test.ts`:

```ts
import { afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  markTemplateFailed,
  markTemplateReady,
  resolveBoxTemplate,
  setTemplateBuildStarter,
} from "../lib/runner/box-template-registry";
import { create } from "../lib/runs";

afterEach(() => {
  delete process.env.TASK_ORCH_BOX_TEMPLATE_ID;
  delete process.env.TASK_ORCH_WORKER_SHA;
  setTemplateBuildStarter(null);
});

function sha(n: number): string {
  return n.toString(16).padStart(40, "0");
}

describe("resolveBoxTemplate", () => {
  it("short-circuits to the pinned template without touching the registry", async () => {
    process.env.TASK_ORCH_BOX_TEMPLATE_ID = "bx_pinned";
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const r = await resolveBoxTemplate({ runId: run.id });
    expect(r).toEqual({ kind: "pinned", boxId: "bx_pinned" });
    expect(starter).not.toHaveBeenCalled();
  });

  it("starts a build on miss and returns building with itself as builder", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(101);
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const r = await resolveBoxTemplate({ runId: run.id });
    expect(r).toMatchObject({ kind: "building", builderRunId: run.id, startedNow: true });
    expect(starter).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id, workerSha: sha(101) })
    );
  });

  it("returns the existing build (not a second one) for a concurrent run", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(102);
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const first = await create({ goal: "<implement>", defer: true });
    const second = await create({ goal: "<implement>", defer: true });
    const a = await resolveBoxTemplate({ runId: first.id });
    const b = await resolveBoxTemplate({ runId: second.id });
    expect(a).toMatchObject({ kind: "building", builderRunId: first.id });
    expect(b).toMatchObject({ kind: "building", builderRunId: first.id, startedNow: false });
    expect(starter).toHaveBeenCalledTimes(1);
  });

  it("returns ready once the build is marked ready, and supersedes older ready rows", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(103);
    setTemplateBuildStarter(vi.fn());
    const run = await create({ goal: "<implement>", defer: true });
    const building = await resolveBoxTemplate({ runId: run.id });
    if (building.kind !== "building") throw new Error("expected building");
    await markTemplateReady(building.registryId, "bx_tpl_103");
    const r = await resolveBoxTemplate({ runId: run.id });
    expect(r).toMatchObject({ kind: "ready", boxId: "bx_tpl_103", workerSha: sha(103) });

    // New SHA: old ready row is superseded once the new one is ready.
    process.env.TASK_ORCH_WORKER_SHA = sha(104);
    const next = await resolveBoxTemplate({ runId: run.id });
    if (next.kind !== "building") throw new Error("expected building");
    await markTemplateReady(next.registryId, "bx_tpl_104");
    const { db: dbi } = await import("../db");
    const { boxTemplates: bt } = await import("../db/schema");
    const [old] = await dbi.select().from(bt).where(eq(bt.boxId, "bx_tpl_103"));
    expect(old.state).toBe("superseded");
  });

  it("retries after a failed build with a fresh building row", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(105);
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const b1 = await resolveBoxTemplate({ runId: run.id });
    if (b1.kind !== "building") throw new Error("expected building");
    await markTemplateFailed(b1.registryId, "npm ci exited 1");
    const b2 = await resolveBoxTemplate({ runId: run.id });
    expect(b2).toMatchObject({ kind: "building", startedNow: true });
    expect(b2.kind === "building" && b2.registryId).not.toBe(b1.registryId);
    expect(starter).toHaveBeenCalledTimes(2);
  });

  it("flips an orphaned building row to failed and starts fresh", async () => {
    process.env.TASK_ORCH_WORKER_SHA = sha(106);
    const starter = vi.fn();
    setTemplateBuildStarter(starter);
    const run = await create({ goal: "<implement>", defer: true });
    const b1 = await resolveBoxTemplate({ runId: run.id });
    if (b1.kind !== "building") throw new Error("expected building");
    // Age the row past the orphan threshold (2 × 7 × step budget).
    const { db: dbi } = await import("../db");
    const { boxTemplates: bt } = await import("../db/schema");
    await dbi
      .update(bt)
      .set({ createdAt: new Date(Date.now() - 2 * 7 * 900 * 1000 - 60_000) })
      .where(eq(bt.id, b1.registryId));
    const b2 = await resolveBoxTemplate({ runId: run.id });
    expect(b2).toMatchObject({ kind: "building", startedNow: true });
    const [orphan] = await dbi.select().from(bt).where(eq(bt.id, b1.registryId));
    expect(orphan.state).toBe("failed");
    expect(orphan.error).toMatch(/orphan/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/box-template-registry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// lib/runner/box-template-registry.ts
//
// App-managed Box template registry (spec 2026-07-17-box-app-managed-template).
// The partial unique index on box_templates(worker_sha) WHERE state IN
// ('building','ready') makes the INSERT below a single-flight lock: exactly
// one dispatch starts a build per worker SHA; the losers observe the winner's
// row and defer behind it.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { boxTemplates } from "../../db/schema";
import { config } from "../config";
import { workerBuildSha } from "./worker-sha";

export type TemplateResolution =
  | { kind: "pinned"; boxId: string }
  | { kind: "ready"; boxId: string; workerSha: string }
  | { kind: "building"; builderRunId: number | null; registryId: number; startedNow: boolean };

export type TemplateBuildStarter = (row: {
  registryId: number;
  runId: number;
  workerSha: string;
}) => void;

// Injected by the provider at construction; a module-level seam (not an
// import) so registry ⇄ builder stays cycle-free and tests can observe kicks.
let buildStarter: TemplateBuildStarter | null = null;
export function setTemplateBuildStarter(fn: TemplateBuildStarter | null): void {
  buildStarter = fn;
}

/** A building row older than 2× the whole-build budget was orphaned by a
 *  server restart (no heartbeat machinery in v1). */
function orphanThresholdMs(): number {
  return 2 * 7 * config.box.buildStepTimeoutSeconds * 1000;
}

export async function resolveBoxTemplate(input: { runId: number }): Promise<TemplateResolution> {
  const pinned = config.box.templateId;
  if (pinned) return { kind: "pinned", boxId: pinned };

  const sha = await workerBuildSha();
  for (;;) {
    const [live] = await db
      .select()
      .from(boxTemplates)
      .where(and(eq(boxTemplates.workerSha, sha), inArray(boxTemplates.state, ["building", "ready"])));

    if (live?.state === "ready" && live.boxId) {
      return { kind: "ready", boxId: live.boxId, workerSha: sha };
    }
    if (live?.state === "building") {
      if (Date.now() - live.createdAt.getTime() > orphanThresholdMs()) {
        await db
          .update(boxTemplates)
          .set({ state: "failed", error: "Template build orphaned (server restarted mid-build)." })
          .where(and(eq(boxTemplates.id, live.id), eq(boxTemplates.state, "building")));
        continue; // re-read; either we insert fresh below or another racer did
      }
      return { kind: "building", builderRunId: live.triggeringRunId, registryId: live.id, startedNow: false };
    }

    // Miss (no live row, or only failed/superseded history): try to claim.
    try {
      const [row] = await db
        .insert(boxTemplates)
        .values({ workerSha: sha, repository: config.box.agentRepo, triggeringRunId: input.runId })
        .returning();
      if (buildStarter) buildStarter({ registryId: row.id, runId: input.runId, workerSha: sha });
      else console.warn(`box_templates ${row.id}: no build starter registered; row will orphan.`);
      return { kind: "building", builderRunId: input.runId, registryId: row.id, startedNow: true };
    } catch {
      // Unique-index conflict: another dispatch won the race. Loop re-reads.
      continue;
    }
  }
}

export async function markTemplateReady(registryId: number, boxId: string): Promise<void> {
  const [row] = await db
    .update(boxTemplates)
    .set({ state: "ready", boxId, readyAt: new Date() })
    .where(eq(boxTemplates.id, registryId))
    .returning();
  if (!row) return;
  // A newer template replaces older ready ones; their Boxes are left for the
  // operator/retention path (explicit non-goal to delete them here).
  await db
    .update(boxTemplates)
    .set({ state: "superseded" })
    .where(and(eq(boxTemplates.state, "ready"), inArray(boxTemplates.id, (
      await db.select({ id: boxTemplates.id }).from(boxTemplates).where(eq(boxTemplates.state, "ready"))
    ).map((r) => r.id).filter((id) => id !== registryId))));
}

export async function markTemplateFailed(registryId: number, error: string): Promise<void> {
  await db
    .update(boxTemplates)
    .set({ state: "failed", error })
    .where(eq(boxTemplates.id, registryId));
}
```

Note: if the two-query supersede reads awkwardly, an equivalent single
`UPDATE box_templates SET state='superseded' WHERE state='ready' AND id <> ${registryId}`
via `sql` is fine — behavior (all other ready rows superseded) is what the test pins.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/box-template-registry.test.ts`
Expected: PASS (7 tests incl. Task 2's smoke test).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-template-registry.ts __tests__/box-template-registry.test.ts
git commit -m "feat(box-template): registry with single-flight resolve and supersede"
```

---

### Task 5: Builder — create blank box, build steps, manifest, archive

**Files:**
- Create: `lib/runner/box-template-builder.ts`
- Modify: `lib/runner/box-client.ts` — add a `create` method to the `BoxClient` interface, the `BoxSdkApi` seam, and the production adapter (SDK `POST /boxes`).
- Modify: `lib/runner/box.ts` — change `async function emitBoxEvent` (~line 105) to `export async function emitBoxEvent` (no other change).
- Modify: `lib/runner/box-template-events.ts` — add to `STEP_LABELS`: `"cloning-agent-repo": "Cloning agent repo",` and `"installing-agent-deps": "Installing agent dependencies",`.
- Test: `__tests__/box-template-builder.test.ts`

**Interfaces:**
- Consumes: `emitTemplateBuildLifecycle` (existing), `waitForBoxReady`/`waitForBoxCheckpoint` (`lib/runner/box-waiters.ts`), `markTemplateReady`/`markTemplateFailed` (T4), `config.box.*` (T3), `BoxClient` (structural, now with `create`), `emitBoxEvent` (export added here), `BOX_TEMPLATE_MANIFEST_PATH`/`BOX_TEMPLATE_WORKER_PROTOCOL_VERSION` (`lib/runner/box-template.ts`).
- Produces:
  - `BoxClient.create(input: { env: Record<string, string>; noEnv: true }): Promise<BoxInfo>` — a fresh blank box (id from the `POST /boxes` `.box` envelope).
  - `runBoxTemplateBuild(client: BoxClient, input: { registryId: number; runId: number; workerSha: string }, opts?: { waitReady?; waitCheckpoint? }): Promise<void>` (Task 6 consumes) — never throws (all failures recorded + emitted).

- [ ] **Step 0: Add `create` to the Box client**

In `lib/runner/box-client.ts`:

Add to the `BoxClient` interface (near `fork`):

```ts
  /** Provision a fresh blank box (POST /boxes). Used by app-managed template
   *  builds, which start from a clean image rather than an operator base box. */
  create(input: { env: Record<string, string>; noEnv: true }): Promise<BoxInfo>;
```

Add to the `BoxSdkApi` seam (near `fork`):

```ts
  create(input: { createBoxRequest: unknown }): Promise<unknown>;
```

Add to the production adapter object (near the `fork` implementation) — the
`POST /boxes` response nests the box under `.box`, so reuse `boxFromEnvelope`:

```ts
    async create(input): Promise<BoxInfo> {
      return boxFromEnvelope(await api.create({ createBoxRequest: input }));
    },
```

(No dedicated unit test for the mapper here; the builder test exercises it
through the fake, and `box-client.test.ts` covers the mapper family — add a
`create` case there only if that file already tests `fork` the same way.)

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/box-template-builder.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentEvents, boxTemplates } from "../db/schema";
import type { BoxClient, BoxCommandResult } from "../lib/runner/box-client";
import { runBoxTemplateBuild } from "../lib/runner/box-template-builder";
import { create } from "../lib/runs";

const KNOBS = ["TASK_ORCH_BOX_AGENT_REPO", "TASK_ORCH_WORKER_SHA"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  vi.restoreAllMocks();
});

const ok: BoxCommandResult = { success: true, timedOut: false, exitCode: 0, stdout: "", stderr: "" };

function fakeClient(overrides: Partial<BoxClient> = {}): { client: BoxClient; commands: string[] } {
  const commands: string[] = [];
  const client = {
    create: vi.fn(async () => ({ id: "bx_new_tpl", state: "ready" })),
    get: vi.fn(async () => ({ id: "bx_new_tpl", state: "ready" })),
    command: vi.fn(async (_boxId: string, input: { command: string }) => {
      commands.push(input.command);
      return ok;
    }),
    stop: vi.fn(async () => ({ id: "bx_new_tpl" })),
    getLatestBoxSnapshot: vi.fn(async () => ({ id: "snap_1", status: "completed", createdAt: new Date() })),
    ...overrides,
  } as unknown as BoxClient;
  return { client, commands };
}

async function seed(sha: string): Promise<{ registryId: number; runId: number }> {
  const run = await create({ goal: "<implement>", defer: true });
  const [row] = await db
    .insert(boxTemplates)
    .values({ workerSha: sha, repository: "nodetool-ai/nodetool", triggeringRunId: run.id })
    .returning();
  return { registryId: row.id, runId: run.id };
}

async function eventTypes(runId: number): Promise<string[]> {
  const rows = await db.select().from(agentEvents).where(eq(agentEvents.sessionId, runId));
  return rows.map((r) => r.type).filter((t) => t.startsWith("runner_box_template_"));
}

const waits = {
  waitReady: vi.fn(async () => ({ id: "bx_new_tpl", state: "ready" })),
  waitCheckpoint: vi.fn(async () => ({
    box: { id: "bx_new_tpl", state: "archived" },
    snapshot: { id: "snap_1", status: "completed" },
  })),
} as never;

describe("runBoxTemplateBuild", () => {
  it("creates a blank box, builds, archives, marks ready, and emits the full lifecycle", async () => {
    const sha = "b".repeat(40);
    const { registryId, runId } = await seed(sha);
    const { client, commands } = fakeClient();

    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);

    // A fresh blank box was created — no base/fork id involved.
    expect(client.create).toHaveBeenCalledWith({ env: {}, noEnv: true });

    const [row] = await db.select().from(boxTemplates).where(eq(boxTemplates.id, registryId));
    expect(row).toMatchObject({ state: "ready", boxId: "bx_new_tpl" });
    expect(row.readyAt).not.toBeNull();

    const types = await eventTypes(runId);
    expect(types[0]).toBe("runner_box_template_building");
    expect(types.filter((t) => t === "runner_box_template_step")).toHaveLength(7);
    expect(types[types.length - 1]).toBe("runner_box_template_ready");

    // The first step verifies the blank-box runtime before cloning.
    expect(commands.some((c) => c.includes("command -v git") && c.includes("node") && c.includes("npm"))).toBe(true);
    // The worker clone checks out the exact SHA and the manifest embeds it.
    expect(commands.some((c) => c.includes(`git checkout ${sha}`))).toBe(true);
    expect(commands.some((c) => c.includes(`"workerBuildSha":"${sha}"`) || c.includes(`\\"workerBuildSha\\":\\"${sha}\\"`))).toBe(true);
    expect(client.stop).toHaveBeenCalledWith("bx_new_tpl");
  });

  it("marks the row failed, emits failed, and stops the box when a step fails", async () => {
    const sha = "c".repeat(40);
    const { registryId, runId } = await seed(sha);
    let calls = 0;
    const { client } = fakeClient({
      command: vi.fn(async () => {
        calls += 1;
        if (calls === 2) return { ...ok, success: false, exitCode: 1, stderr: "npm ci exited 1" };
        return ok;
      }) as never,
    });

    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);

    const [row] = await db.select().from(boxTemplates).where(eq(boxTemplates.id, registryId));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/installing-deps|npm ci/);
    const types = await eventTypes(runId);
    expect(types[types.length - 1]).toBe("runner_box_template_failed");
    expect(client.stop).toHaveBeenCalled(); // best-effort cleanup
  });

  it("fails cleanly when the blank box cannot be created", async () => {
    const sha = "d".repeat(40);
    const { registryId, runId } = await seed(sha);
    const { client } = fakeClient({
      create: vi.fn(async () => {
        throw new Error("Box account cannot start another box");
      }) as never,
    });
    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);
    const [row] = await db.select().from(boxTemplates).where(eq(boxTemplates.id, registryId));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/cannot start another box/);
    expect(await eventTypes(runId)).toContain("runner_box_template_failed");
    // Nothing was created, so there is no box to stop.
    expect(client.stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/box-template-builder.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Export `emitBoxEvent` in `lib/runner/box.ts` and add the two `STEP_LABELS` entries, then:

```ts
// lib/runner/box-template-builder.ts
//
// Executes one app-managed template build inside a FRESH BLANK box (created via
// client.create — no operator base box), mirroring scripts/install-box-template.sh,
// wrapped in emitTemplateBuildLifecycle so the triggering run's stepper shows
// live progress. Never throws: every failure is recorded on the registry row
// and emitted as runner_box_template_failed.
import { config } from "../config";
import type { BoxClient } from "./box-client";
import { emitBoxEvent } from "./box";
import { BOX_TEMPLATE_MANIFEST_PATH, BOX_TEMPLATE_WORKER_PROTOCOL_VERSION } from "./box-template";
import { emitTemplateBuildLifecycle } from "./box-template-events";
import { markTemplateFailed, markTemplateReady } from "./box-template-registry";
import { waitForBoxCheckpoint, waitForBoxReady } from "./box-waiters";

const BUILD_STEPS = [
  "cloning-worker",
  "installing-deps",
  "building-worker",
  "cloning-agent-repo",
  "installing-agent-deps",
  "writing-manifest",
  "archiving",
] as const;

const WORKER_DIR = "/home/user/task-orchestrator";

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runBoxTemplateBuild(
  client: BoxClient,
  input: { registryId: number; runId: number; workerSha: string },
  opts: {
    waitReady?: typeof waitForBoxReady;
    waitCheckpoint?: typeof waitForBoxCheckpoint;
  } = {}
): Promise<void> {
  const waitReady = opts.waitReady ?? waitForBoxReady;
  const waitCheckpoint = opts.waitCheckpoint ?? waitForBoxCheckpoint;
  const emit = (type: string, payload: Record<string, unknown>) =>
    emitBoxEvent(input.runId, type, payload);
  let boxId: string | undefined;

  const run = async (boxIdNow: string, label: string, command: string): Promise<void> => {
    const result = await client.command(boxIdNow, {
      command,
      cwd: ".",
      timeoutSeconds: config.box.buildStepTimeoutSeconds,
    });
    if (!result.success || result.timedOut || result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "").slice(-2_000);
      throw new Error(`Template build step ${label} failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${detail}`);
    }
  };

  try {
    await emitTemplateBuildLifecycle({
      emit,
      workerSha: input.workerSha,
      reason: "no-template",
      steps: BUILD_STEPS,
      build: async (step) => {
        // Provision a fresh blank box — no operator-provided base. A blank
        // image ships with git/node/npm; the cloning-worker step verifies that
        // runtime first so a missing tool fails legibly.
        const blank = await client.create({ env: {}, noEnv: true });
        boxId = blank.id;
        await waitReady(client, boxId, { timeoutMs: config.box.readyTimeoutMs });

        const repoPath = config.box.repoPath ?? "/home/user/repository";

        await step("cloning-worker");
        await run(boxId, "cloning-worker",
          `set -eu; command -v git >/dev/null && command -v node >/dev/null && command -v npm >/dev/null || { echo "blank box missing git/node/npm" >&2; exit 127; }; test ! -e ${shq(WORKER_DIR)}; git clone --branch ${shq(config.box.workerRepoRef)} ${shq(config.box.workerRepoUrl)} ${shq(WORKER_DIR)}; cd ${shq(WORKER_DIR)}; git checkout ${input.workerSha}`);

        await step("installing-deps");
        await run(boxId, "installing-deps", `set -eu; cd ${shq(WORKER_DIR)}; npm ci`);

        await step("building-worker");
        await run(boxId, "building-worker",
          `set -eu; cd ${shq(WORKER_DIR)}; npm run build:worker; test -s dist/run-worker.js`);

        await step("cloning-agent-repo");
        await run(boxId, "cloning-agent-repo",
          `set -eu; test ! -e ${shq(repoPath)}; git clone --depth 1 ${shq(config.box.agentRepoUrl)} ${shq(repoPath)}`);

        await step("installing-agent-deps");
        await run(boxId, "installing-agent-deps", `set -eu; cd ${shq(repoPath)}; npm ci`);

        await step("writing-manifest");
        const manifest = JSON.stringify({
          formatVersion: 1,
          workerBuildSha: input.workerSha,
          workerProtocolVersion: BOX_TEMPLATE_WORKER_PROTOCOL_VERSION,
          repository: config.box.agentRepo,
          repositoryPath: repoPath,
        });
        await run(boxId, "writing-manifest",
          `set -eu; mkdir -p /home/user/.task-orchestrator; printf '%s\\n' ${shq(manifest)} > ${shq(BOX_TEMPLATE_MANIFEST_PATH)}`);

        await step("archiving");
        const requestedAt = Date.now();
        await client.stop(boxId);
        await waitCheckpoint(client, boxId, requestedAt, { timeoutMs: config.box.readyTimeoutMs * 5 });

        await markTemplateReady(input.registryId, boxId);
        return { templateId: boxId };
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markTemplateFailed(input.registryId, message);
    if (boxId) {
      try {
        await client.stop(boxId);
      } catch {
        // Best-effort cleanup; the retention sweep owns stragglers.
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/box-template-builder.test.ts __tests__/box-template-events.test.ts`
Expected: PASS (builder 3 tests; events file unaffected by the label additions).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-template-builder.ts lib/runner/box-client.ts lib/runner/box.ts lib/runner/box-template-events.ts __tests__/box-template-builder.test.ts
git commit -m "feat(box-template): app-managed template builder over the Box command API"
```

---

### Task 6: Provider wiring — admit gate + create() resolution

**Files:**
- Modify: `lib/runner/box.ts`:
  - `BoxRunnerProvider.admit()` (~line 187): template gate before the limits probe.
  - `create()` (~lines 251–258): resolve template id from pin/registry; pass `templateVersion`.
  - Constructor (~line 178): register the build starter.
- Test: `__tests__/box-template-provider.test.ts`

**Interfaces:**
- Consumes: `resolveBoxTemplate`, `setTemplateBuildStarter` (T4), `runBoxTemplateBuild` (T5), existing `boxAdmissionDecision`.
- Produces: admit defers with the two reason strings; create() forks from the resolved template.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/box-template-provider.test.ts
// Spec §5: admission defers behind the template build with run-visible
// reasons; create() forks from the resolved registry template when unpinned.
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { boxTemplates } from "../db/schema";
import type { BoxClient } from "../lib/runner/box-client";
import { BoxRunnerProvider } from "../lib/runner/box";
import { setTemplateBuildStarter } from "../lib/runner/box-template-registry";
import { create } from "../lib/runs";

const KNOBS = ["TASK_ORCH_RUNNER", "TASK_ORCH_BOX_TEMPLATE_ID", "TASK_ORCH_WORKER_SHA", "BOX_API_KEY"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  setTemplateBuildStarter(null);
  vi.restoreAllMocks();
});

const limitsOk = { canStart: true, activeBoxes: 0, maxActiveBoxes: 10 };

describe("BoxRunnerProvider template gate", () => {
  it("defers the builder run with the building reason", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "1".repeat(40);
    const provider = new BoxRunnerProvider({ limits: vi.fn(async () => limitsOk) } as unknown as BoxClient);
    // AFTER construction: the constructor registers the real starter, and a
    // real background build against the fake client would race this test.
    setTemplateBuildStarter(vi.fn());
    const run = await create({ goal: "<implement>", defer: true });
    await expect(provider.admit({ runId: run.id, reservedActive: 0 })).resolves.toEqual({
      decision: "defer",
      reason: "Building box template…",
    });
  });

  it("defers a second run behind the builder with the waiting reason", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "2".repeat(40);
    const provider = new BoxRunnerProvider({ limits: vi.fn(async () => limitsOk) } as unknown as BoxClient);
    setTemplateBuildStarter(vi.fn()); // after construction — see test 1
    const builder = await create({ goal: "<implement>", defer: true });
    const waiter = await create({ goal: "<implement>", defer: true });
    await provider.admit({ runId: builder.id, reservedActive: 0 });
    await expect(provider.admit({ runId: waiter.id, reservedActive: 0 })).resolves.toEqual({
      decision: "defer",
      reason: `Waiting for box template build (started by run #${builder.id})`,
    });
  });

  it("falls through to the limits probe when the template is ready", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "3".repeat(40);
    await db.insert(boxTemplates).values({
      workerSha: "3".repeat(40),
      repository: "nodetool-ai/nodetool",
      state: "ready",
      boxId: "bx_ready_tpl",
    });
    const limits = vi.fn(async () => limitsOk);
    const provider = new BoxRunnerProvider({ limits } as unknown as BoxClient);
    const run = await create({ goal: "<implement>", defer: true });
    await expect(provider.admit({ runId: run.id, reservedActive: 0 })).resolves.toEqual({ decision: "admit" });
    expect(limits).toHaveBeenCalled();
  });

  it("skips the registry entirely when a template id is pinned", async () => {
    process.env.TASK_ORCH_BOX_TEMPLATE_ID = "bx_pinned";
    const provider = new BoxRunnerProvider({ limits: vi.fn(async () => limitsOk) } as unknown as BoxClient);
    const starter = vi.fn();
    setTemplateBuildStarter(starter); // after construction — see test 1
    const run = await create({ goal: "<implement>", defer: true });
    await expect(provider.admit({ runId: run.id, reservedActive: 0 })).resolves.toEqual({ decision: "admit" });
    expect(starter).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/box-template-provider.test.ts`
Expected: FAIL — admit() admits instead of deferring (no template gate yet).

- [ ] **Step 3: Implement**

In `lib/runner/box.ts`:

Imports:

```ts
import { resolveBoxTemplate, setTemplateBuildStarter } from "./box-template-registry";
import { runBoxTemplateBuild } from "./box-template-builder";
```

Constructor — register the starter once (idempotent; last registration wins,
and every registration routes through this provider's lazily-created client):

```ts
  constructor(clientOrFactory: BoxClient | (() => BoxClient) = makeBoxClient) {
    this.clientFactory = typeof clientOrFactory === "function" ? clientOrFactory : () => clientOrFactory;
    // App-managed template builds run in-process, fire-and-forget; the
    // registry row + lifecycle events carry all observable state.
    setTemplateBuildStarter((row) => {
      void runBoxTemplateBuild(this.box(), row).catch((error) => {
        console.error(`box template build ${row.registryId} crashed:`, error);
      });
    });
  }
```

`admit()` — template gate before the limits probe:

```ts
  async admit(input: RunnerAdmissionInput): Promise<RunnerAdmission> {
    try {
      const template = await resolveBoxTemplate({ runId: input.runId });
      if (template.kind === "building") {
        return {
          decision: "defer",
          reason:
            template.builderRunId === input.runId
              ? "Building box template…"
              : `Waiting for box template build (started by run #${template.builderRunId})`,
        };
      }
      return boxAdmissionDecision(await this.box().limits(), input);
    } catch (error) {
      // ...existing normalizeBoxApiError switch unchanged...
```

`create()` — replace the pinned-only resolution (~lines 251–258):

```ts
    const template = await resolveBoxTemplate({ runId: input.runId });
    if (template.kind === "building") {
      // Admission should have deferred; a direct create() during a build is a
      // caller bug, and forking without a template is impossible.
      throw new Error("Box template is still building; the run must remain deferred.");
    }
    const templateId = template.boxId;
    const env = buildBoxWorkerEnv({
      runId: input.runId,
      repoId: run.repoId,
      channelInstanceId,
      ...(template.kind === "ready" ? { templateVersion: template.workerSha } : {}),
    });
```

(Delete the old `const templateId = config.box.templateId; if (!templateId) throw ...` lines; `validateBoxConfig()` at the top of `create()` still enforces the `BOX_API_KEY` requirement — Task 3.)

- [ ] **Step 4: Run the new + neighboring suites**

Run: `npx vitest run __tests__/box-template-provider.test.ts __tests__/box-provider-e2e.test.ts __tests__/box-admission.test.ts __tests__/pending-reason.test.ts`
Expected: PASS. The e2e suite pins `TASK_ORCH_BOX_TEMPLATE_ID` in its env setup, so it takes the pinned path unchanged — if any of its cases now fail wanting a registry row, set `TASK_ORCH_BOX_TEMPLATE_ID` in that test's env rather than weakening the gate.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add lib/runner/box.ts __tests__/box-template-provider.test.ts
git commit -m "feat(box-runner): admission template gate and registry-resolved forks"
```

---

### Task 7: Metrics, env, docs, close the gap

**Files:**
- Modify: `app/api/metrics/route.ts` (box_templates by state next to the `runner_instances` report, ~line 39)
- Modify: `.env.example` (Box section, ~line 115)
- Modify: `.env.local` (drop the template-id requirement — app-managed is the default)
- Modify: `docs/box-deployment.md` (app-managed lifecycle section)
- Modify: `BOX_TEMPLATE_UI_FEEDBACK_GAP.md` (status → closed)
- Test: `__tests__/metrics-box-templates.test.ts` (only if `app/api/metrics` already has a route test to model after — check `ls __tests__ | grep -i metric`; if none exists, verify via typecheck and skip the route test rather than building a Next request harness)

**Interfaces:** consumes `boxTemplates` (T2).

- [ ] **Step 1: Metrics**

In `app/api/metrics/route.ts`, mirror the `runnerRows` query:

```ts
  const templateRows = await db
    .select({ state: boxTemplates.state, count: sql<number>`count(*)::int` })
    .from(boxTemplates)
    .groupBy(boxTemplates.state);
```

and include it in the JSON payload as `box_templates: templateRows` alongside the existing runner report (match the route's existing response shape — read the file first).

- [ ] **Step 2: `.env.example`**

In the Box section after the `TASK_ORCH_BOX_REPO_PATH` line, add:

```text
#
# App-managed templates (DEFAULT): leave TASK_ORCH_BOX_TEMPLATE_ID unset and
# the app builds a template per worker build SHA on first dispatch, starting
# from a fresh blank box it creates itself — no base box to provision. BOX_API_KEY
# alone is enough. Live progress shows in the run view. A pinned TEMPLATE_ID
# disables app-managed builds. Overrides (all optional):
# TASK_ORCH_BOX_WORKER_REPO_URL=https://github.com/nodetool-ai/task-orchestrator.git
# TASK_ORCH_BOX_WORKER_REPO_REF=main
# TASK_ORCH_BOX_AGENT_REPO_URL=https://github.com/nodetool-ai/nodetool.git
# TASK_ORCH_BOX_AGENT_REPO=nodetool-ai/nodetool
# TASK_ORCH_BOX_BUILD_STEP_TIMEOUT_S=900
# TASK_ORCH_WORKER_SHA=                       # git-less deployments only
```

- [ ] **Step 3: `.env.local`**

Remove any `TASK_ORCH_BOX_TEMPLATE_ID=` / `TASK_ORCH_BOX_TEMPLATE_VERSION=` /
`TASK_ORCH_BOX_BASE_ID=` lines (a prior edit may have added a base-id line —
delete it). Leave a comment in their place:

```text
# App-managed templates are the default: the app builds a template per worker
# SHA on first dispatch (10–15 min, live progress in the run view), creating a
# fresh blank box itself. BOX_API_KEY alone is enough — no template/base id.
# Pin TASK_ORCH_BOX_TEMPLATE_ID only to override with a hand-published template.
# TASK_ORCH_BOX_TEMPLATE_ID=
```

Update the comment above `TASK_ORCH_BOX_REPO_PATH=/home/user/nodetool` to note it is also the path baked into app-built templates.

- [ ] **Step 4: `docs/box-deployment.md`**

After the "Template lifecycle" heading, insert a short "App-managed templates" subsection: unset pin → lazy per-SHA build at dispatch, starting from a blank box the app creates itself (steps, ~10–15 min, stepper feedback, `box_templates` registry + metrics), `BOX_API_KEY` the only requirement, pin = manual override using the existing publish flow, `TASK_ORCH_WORKER_SHA` for git-less control planes, failed builds retry on the pump cadence.

- [ ] **Step 5: Close the gap doc**

In `BOX_TEMPLATE_UI_FEEDBACK_GAP.md` change the Status line to:

```markdown
**Status:** closed 2026-07-17 — feedback shipped (04b25ec..b46c44a), app-managed provisioning shipped alongside (specs `2026-07-17-box-template-build-feedback-design.md`, `2026-07-17-box-app-managed-template-design.md`).
```

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npx vitest run __tests__/box-template-registry.test.ts __tests__/box-template-builder.test.ts`
Expected: clean / PASS.

```bash
git add app/api/metrics/route.ts .env.example docs/box-deployment.md BOX_TEMPLATE_UI_FEEDBACK_GAP.md
git commit -m "feat(box-template): metrics surface, env docs, close the feedback gap"
```

(`.env.local` is gitignored — edit it but it won't be committed.)

---

## Spec coverage self-check

- §1 registry table → T2. §2 worker SHA → T1. §3 resolve/single-flight/supersede/orphan → T4. §4 builder (blank-box create + `BoxClient.create` + steps + runtime check + labels + cleanup) → T5. §5 admit gate + create() → T6. §6 config (no base-id; `BOX_API_KEY`-only validation) → T3. §7 metrics → T7. §8 docs/env/gap → T7. Error handling: failed rows (T4/T5 tests), orphan flip (T4), blank-box create failure + missing-runtime (T5), SHA-not-pushed via step-1 failure. Testing section maps 1:1 to the task test files.
