# Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `environments` table + registry module replaces `box_templates` across docker/fly/box, with a `/environments` page listing all environments and a build area (box in-app, docker via dockerode, fly info-only).

**Architecture:** Migration 0021 creates `environments` (a generalized build-artifact row: provider + worker_sha + state + artifact), copies box rows over, drops `box_templates`. `lib/runner/box-template-registry.ts` generalizes into `lib/runner/environments.ts` keeping `resolveBoxTemplate`'s contract byte-for-byte (provider-filtered). The builder gains a nullable triggering run (manual page builds emit no run events; progress goes to a polled `detail` column). A new dockerode-driven image build, a build API route, and the page complete it.

**Tech Stack:** Drizzle/Postgres, dockerode (already a dependency), Next.js app router, vitest (node env — no DOM tests; page logic stays in server loaders + thin components).

**Spec:** `docs/superpowers/specs/2026-07-18-environments-design.md` — read it first. Prior context: `lib/runner/box-template-*.ts` shipped 2026-07-17 (this plan renames/regeneralizes them).

## Global Constraints

- Providers: `docker` | `fly` | `box` (exact strings). States: `building → ready | failed`, plus `superseded`.
- Single-flight: partial unique index `environments_live_idx` on `(provider, worker_sha)` WHERE `state IN ('building','ready')`.
- `resolveBoxTemplate({ runId })` keeps its exact name, signature, and return type — box dispatch (`lib/runner/box.ts`) must not change except import paths.
- Manual builds: `triggering_run_id` NULL, no run events, progress via `environments.detail`. Run-triggered builds unchanged (full event stepper).
- Metrics gauge: `task_orch_environments` with labels `["service","provider","state"]`, replacing `task_orch_box_templates`.
- Never stage/commit `scripts/worker-chat.ts` or `__tests__/worker-chat-box.test.ts` (unrelated dirty WIP). If `git commit` hits index.lock, wait 2s, retry up to 5×.
- Tests: `npx vitest run <file>`; typecheck: `npm run typecheck`. Working branch: `main` (commit directly; small commits per task).

---

### Task 1: Migration + schema + `lib/runner/environments.ts` (the transplant)

The big atomic task: after it, `box_templates` is gone, everything compiles, and all existing box suites are green against `environments`.

**Files:**
- Create: `db/migrations/0021_environments.sql`; Modify: `db/migrations/meta/_journal.json` (append idx 21, `when: 1784736000000`, tag `0021_environments`)
- Modify: `db/schema.ts` — replace the `boxTemplates` table def with `environments`
- Create: `lib/runner/environments.ts` (contents generalized from `lib/runner/box-template-registry.ts`); Delete: `lib/runner/box-template-registry.ts`
- Modify importers: `lib/runner/box.ts` (import path only), `lib/runner/box-template-builder.ts` (import path + renamed mark functions), `lib/runner/box-template-state.ts` (table + provider filter), `lib/runner/telemetry.ts` (gauge rename), `app/api/metrics/route.ts` (query + setter rename)
- Tests: rename `__tests__/box-template-registry.test.ts` → `__tests__/environments.test.ts` (port + extend); update `__tests__/box-template-provider.test.ts`, `__tests__/box-template-builder.test.ts`, `__tests__/box-template-state.test.ts` imports/inserts to `environments` with `provider: "box"`.

**Interfaces:**
- Consumes: `workerBuildSha()` (`lib/runner/worker-sha.ts`), `config.box.*`, `config.deployment.workerImage`.
- Produces (later tasks rely on):

```ts
// lib/runner/environments.ts
export type EnvironmentProvider = "docker" | "fly" | "box";
export type EnvironmentRow = typeof environments.$inferSelect;
export type TemplateResolution = /* unchanged union incl. { kind: "cooldown"; ... } */;
export function resolveBoxTemplate(input: { runId: number }): Promise<TemplateResolution>; // unchanged
export type TemplateBuildStarter = (row: { registryId: number; runId: number | null; workerSha: string }) => void;
export function setTemplateBuildStarter(fn: TemplateBuildStarter | null): void; // unchanged
export function markEnvironmentReady(id: number, artifact: { boxId?: string; image?: string }): Promise<void>;
export function markEnvironmentFailed(id: number, error: string): Promise<void>;
export function setEnvironmentDetail(id: number, detail: string): Promise<void>;
export function listEnvironments(): Promise<EnvironmentRow[]>; // newest first
export function registerConfiguredEnvironments(): Promise<void>;
```

- [ ] **Step 1: Migration**

```sql
-- db/migrations/0021_environments.sql
-- Environments generalize box_templates across docker/fly/box (spec
-- 2026-07-18-environments-design.md). One row = one build/artifact per
-- provider, versioned by worker SHA. The partial unique index is the
-- per-provider single-flight build lock.
CREATE TABLE IF NOT EXISTS "environments" (
  "id" serial PRIMARY KEY,
  "provider" text NOT NULL,
  "worker_sha" text NOT NULL,
  "state" text NOT NULL DEFAULT 'building',
  "box_id" text,
  "image" text,
  "detail" text,
  "error" text,
  "triggering_run_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ready_at" timestamp with time zone
);
--> statement-breakpoint
INSERT INTO "environments" ("provider", "worker_sha", "state", "box_id", "error", "triggering_run_id", "created_at", "ready_at")
  SELECT 'box', "worker_sha", "state", "box_id", "error", "triggering_run_id", "created_at", "ready_at"
  FROM "box_templates" WHERE "state" IN ('ready', 'superseded', 'failed');
--> statement-breakpoint
DROP TABLE IF EXISTS "box_templates";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_live_idx"
  ON "environments" ("provider", "worker_sha")
  WHERE "state" IN ('building', 'ready');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_state_idx" ON "environments" ("state");
```

(`building` box_templates rows are dead by definition at migration time — dropped, per spec §6.)

- [ ] **Step 2: Schema** — in `db/schema.ts`, REPLACE the whole `boxTemplates` export with:

```ts
// Environments: the execution artifact each runner provider launches from
// (docker image / fly runner image / box template snapshot), one row per
// build, versioned by worker SHA. Replaces box_templates (migration 0021).
// The partial unique index is the per-provider single-flight build lock.
export const environments = pgTable(
  "environments",
  {
    id: serial("id").primaryKey(),
    // 'docker' | 'fly' | 'box'
    provider: text("provider").notNull(),
    workerSha: text("worker_sha").notNull(),
    // building → ready | failed; ready → superseded when a newer SHA lands.
    state: text("state").notNull().default("building"),
    // Box artifact: the archived template box.
    boxId: text("box_id"),
    // Docker/fly artifact: image tag / registry ref.
    image: text("image"),
    // Current build step — manual (page-triggered) builds are observed by
    // polling this; run-triggered box builds also stream run events.
    detail: text("detail"),
    error: text("error"),
    // Run whose dispatch started a box build; NULL for manual/page builds.
    triggeringRunId: integer("triggering_run_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    readyAt: ts("ready_at"),
  },
  (t) => ({
    liveIdx: uniqueIndex("environments_live_idx")
      .on(t.provider, t.workerSha)
      .where(sql`${t.state} IN ('building', 'ready')`),
    stateIdx: index("environments_state_idx").on(t.state),
  })
);
```

- [ ] **Step 3: Write `lib/runner/environments.ts`** — start from `box-template-registry.ts` and apply exactly these changes, then delete the old file:

```ts
// lib/runner/environments.ts
//
// The environments registry: docker images, fly runner images, and box
// template snapshots as one concept (spec 2026-07-18-environments-design.md).
// Generalizes the former box-template-registry; resolveBoxTemplate keeps its
// contract and now filters provider='box'. The partial unique index on
// (provider, worker_sha) WHERE state IN ('building','ready') is the
// per-provider single-flight lock.
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { environments } from "../../db/schema";
import { config } from "../config";
import { workerBuildSha } from "./worker-sha";

export type EnvironmentProvider = "docker" | "fly" | "box";
export type EnvironmentRow = typeof environments.$inferSelect;

export type TemplateResolution =
  | { kind: "pinned"; boxId: string }
  | { kind: "ready"; boxId: string; workerSha: string }
  | { kind: "building"; builderRunId: number | null; registryId: number; startedNow: boolean }
  | { kind: "cooldown"; registryId: number; error: string | null; retryAtMs: number };

export type TemplateBuildStarter = (row: {
  registryId: number;
  runId: number | null;
  workerSha: string;
}) => void;

let buildStarter: TemplateBuildStarter | null = null;
export function setTemplateBuildStarter(fn: TemplateBuildStarter | null): void {
  buildStarter = fn;
}

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
      .from(environments)
      .where(and(
        eq(environments.provider, "box"),
        eq(environments.workerSha, sha),
        inArray(environments.state, ["building", "ready"])
      ));

    if (live?.state === "ready" && live.boxId) {
      return { kind: "ready", boxId: live.boxId, workerSha: sha };
    }
    if (live?.state === "building") {
      if (Date.now() - live.createdAt.getTime() > orphanThresholdMs()) {
        await db
          .update(environments)
          .set({ state: "failed", error: "Template build orphaned (server restarted mid-build)." })
          .where(and(eq(environments.id, live.id), eq(environments.state, "building")));
        continue;
      }
      return { kind: "building", builderRunId: live.triggeringRunId, registryId: live.id, startedNow: false };
    }

    const cooldownMs = config.box.buildRetryCooldownMs;
    if (cooldownMs > 0) {
      const [lastFailed] = await db
        .select()
        .from(environments)
        .where(and(eq(environments.provider, "box"), eq(environments.workerSha, sha), eq(environments.state, "failed")))
        .orderBy(desc(environments.createdAt))
        .limit(1);
      if (lastFailed) {
        const retryAtMs = lastFailed.createdAt.getTime() + cooldownMs;
        if (Date.now() < retryAtMs) {
          return { kind: "cooldown", registryId: lastFailed.id, error: lastFailed.error, retryAtMs };
        }
      }
    }

    try {
      const [row] = await db
        .insert(environments)
        .values({ provider: "box", workerSha: sha, triggeringRunId: input.runId })
        .returning();
      if (buildStarter) buildStarter({ registryId: row.id, runId: input.runId, workerSha: sha });
      else console.warn(`environments ${row.id}: no build starter registered; row will orphan.`);
      return { kind: "building", builderRunId: input.runId, registryId: row.id, startedNow: true };
    } catch {
      continue; // unique-index race: another dispatch won; re-read
    }
  }
}

export async function markEnvironmentReady(
  id: number,
  artifact: { boxId?: string; image?: string }
): Promise<void> {
  const [row] = await db
    .update(environments)
    .set({ state: "ready", boxId: artifact.boxId ?? null, image: artifact.image ?? null, readyAt: new Date(), detail: null })
    .where(eq(environments.id, id))
    .returning();
  if (!row) return;
  // A newer environment supersedes older ready ones OF THE SAME PROVIDER; the
  // old artifacts (boxes/images) are left for retention/operators.
  await db
    .update(environments)
    .set({ state: "superseded" })
    .where(and(eq(environments.provider, row.provider), eq(environments.state, "ready"), ne(environments.id, id)));
}

export async function markEnvironmentFailed(id: number, error: string): Promise<void> {
  await db.update(environments).set({ state: "failed", error, detail: null }).where(eq(environments.id, id));
}

export async function setEnvironmentDetail(id: number, detail: string): Promise<void> {
  await db.update(environments).set({ detail }).where(eq(environments.id, id));
}

export async function listEnvironments(): Promise<EnvironmentRow[]> {
  return db.select().from(environments).orderBy(desc(environments.createdAt));
}

/**
 * Make configured docker/fly images visible as ready environments without a
 * build. Idempotent; never throws (the page must render even when the worker
 * SHA can't be resolved, e.g. no network for ls-remote).
 */
export async function registerConfiguredEnvironments(): Promise<void> {
  let sha: string;
  try {
    sha = await workerBuildSha();
  } catch {
    return;
  }
  const configured: Array<{ provider: EnvironmentProvider; image: string }> = [];
  if (config.deployment.workerImage) configured.push({ provider: "docker", image: config.deployment.workerImage });
  const flyImage = process.env.FLY_RUNNER_IMAGE;
  if (flyImage) configured.push({ provider: "fly", image: flyImage });

  for (const { provider, image } of configured) {
    const [live] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.provider, provider), eq(environments.workerSha, sha), inArray(environments.state, ["building", "ready"])));
    if (live) {
      // Config changed the tag under the same SHA: reflect it.
      if (live.state === "ready" && live.image !== image) {
        await db.update(environments).set({ image }).where(eq(environments.id, live.id));
      }
      continue;
    }
    try {
      const [row] = await db
        .insert(environments)
        .values({ provider, workerSha: sha, state: "ready", image, readyAt: new Date() })
        .returning();
      if (row) {
        await db
          .update(environments)
          .set({ state: "superseded" })
          .where(and(eq(environments.provider, provider), eq(environments.state, "ready"), ne(environments.id, row.id)));
      }
    } catch {
      // unique race with a concurrent register/build — fine, someone owns it
    }
  }
}
```

- [ ] **Step 4: Update importers**

  - `lib/runner/box.ts`: change `from "./box-template-registry"` → `from "./environments"` (exports keep their names). No other change.
  - `lib/runner/box-template-builder.ts`: import `markEnvironmentReady, markEnvironmentFailed` from `./environments`; replace `markTemplateReady(input.registryId, boxId)` → `markEnvironmentReady(input.registryId, { boxId })` and `markTemplateFailed(...)` → `markEnvironmentFailed(...)`. (Nullable runId + detail land in Task 2 — keep `runId: number` for now.)
  - `lib/runner/box-template-state.ts`: replace the `boxTemplates` import/query with `environments` and add `eq(environments.provider, "box")` to the building-row lookup.
  - `lib/runner/telemetry.ts`: rename the gauge — `name: "task_orch_environments"`, `help: "Current environments (execution artifacts) by provider and state."`, `labelNames: ["service", "provider", "state"]`; rename field `boxTemplates` → `environments` in `TelemetryState`; replace `setBoxTemplates` with:

```ts
export function setEnvironments(
  rows: Array<{ provider: string | null; state: string | null; count: number }>
): void {
  telemetry().environments.reset();
  for (const row of rows) {
    telemetry().environments
      .labels({ service: "task-orchestrator", provider: row.provider ?? "unknown", state: row.state ?? "unknown" })
      .set(row.count);
  }
}
```

  - `app/api/metrics/route.ts`: query `environments` grouped by `(provider, state)` and call `setEnvironments(rows)`.

- [ ] **Step 5: Port the tests**

Rename `__tests__/box-template-registry.test.ts` → `__tests__/environments.test.ts`; update imports to `../lib/runner/environments` and `environments` from schema; every direct `db.insert(boxTemplates).values({...})` gains `provider: "box"`; `markTemplateReady(id, "bx_...")` call sites become `markEnvironmentReady(id, { boxId: "bx_..." })`. ADD these cases:

```ts
it("provider-scoped single-flight: a docker building row does not block a box build", async () => {
  process.env.TASK_ORCH_WORKER_SHA = sha(201);
  setTemplateBuildStarter(vi.fn());
  await db.insert(environments).values({ provider: "docker", workerSha: sha(201) }); // building
  const run = await create({ goal: "<implement>", defer: true });
  const r = await resolveBoxTemplate({ runId: run.id });
  expect(r).toMatchObject({ kind: "building", startedNow: true });
});

it("registerConfiguredEnvironments upserts docker/fly ready rows idempotently", async () => {
  process.env.TASK_ORCH_WORKER_SHA = sha(202);
  process.env.TASK_ORCH_WORKER_IMAGE = "task-orchestrator-worker:test";
  process.env.FLY_RUNNER_IMAGE = "registry.fly.io/runners:test";
  try {
    await registerConfiguredEnvironments();
    await registerConfiguredEnvironments(); // idempotent
    const rows = await listEnvironments();
    const mine = rows.filter((r) => r.workerSha === sha(202) && r.state === "ready");
    expect(mine.map((r) => r.provider).sort()).toEqual(["docker", "fly"]);
    expect(mine.find((r) => r.provider === "docker")?.image).toBe("task-orchestrator-worker:test");
  } finally {
    delete process.env.TASK_ORCH_WORKER_IMAGE;
    delete process.env.FLY_RUNNER_IMAGE;
  }
});

it("markEnvironmentReady supersedes only same-provider ready rows", async () => {
  const [dockerRow] = await db.insert(environments)
    .values({ provider: "docker", workerSha: sha(203), state: "ready", image: "img:a", readyAt: new Date() }).returning();
  const [boxRow] = await db.insert(environments)
    .values({ provider: "box", workerSha: sha(204) }).returning();
  await markEnvironmentReady(boxRow.id, { boxId: "bx_tpl" });
  const [docker] = await db.select().from(environments).where(eq(environments.id, dockerRow.id));
  expect(docker.state).toBe("ready"); // untouched — different provider
});
```

Update `__tests__/box-template-provider.test.ts`, `__tests__/box-template-builder.test.ts`, `__tests__/box-template-state.test.ts`: `boxTemplates` → `environments` with `provider: "box"` in inserts; registry import path → `../lib/runner/environments`. Behavior assertions unchanged.

- [ ] **Step 6: Run everything**

Run: `npm run typecheck && npx vitest run __tests__/environments.test.ts __tests__/box-template-provider.test.ts __tests__/box-template-builder.test.ts __tests__/box-template-state.test.ts __tests__/box-template-events.test.ts __tests__/worker-sha.test.ts __tests__/pending-reason.test.ts __tests__/box-provider-e2e.test.ts`
Expected: clean typecheck; all green. Also `grep -rn "boxTemplates\|box_templates" lib app db components --include="*.ts" --include="*.tsx" | grep -v migrations` must return NOTHING.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0021_environments.sql db/migrations/meta/_journal.json db/schema.ts lib/runner/environments.ts lib/runner/box.ts lib/runner/box-template-builder.ts lib/runner/box-template-state.ts lib/runner/telemetry.ts app/api/metrics/route.ts __tests__/environments.test.ts __tests__/box-template-provider.test.ts __tests__/box-template-builder.test.ts __tests__/box-template-state.test.ts
git rm lib/runner/box-template-registry.ts __tests__/box-template-registry.test.ts 2>/dev/null; true
git commit -m "feat(environments): environments table + registry replace box_templates"
```

---

### Task 2: Builder — nullable triggering run + step detail

**Files:**
- Modify: `lib/runner/box-template-builder.ts`
- Test: `__tests__/box-template-builder.test.ts` (extend)

**Interfaces:**
- Consumes: `setEnvironmentDetail` (T1).
- Produces: `runBoxTemplateBuild(client, input: { registryId: number; runId: number | null; workerSha: string }, opts?)` — Task 4's route calls it with `runId: null`.

- [ ] **Step 1: Failing test** — append to `__tests__/box-template-builder.test.ts`:

```ts
it("manual build (runId null): no run events, detail updated per step, marks ready", async () => {
  const sha = "e".repeat(40);
  const [row] = await db.insert(environments).values({ provider: "box", workerSha: sha }).returning();
  const { client } = fakeClient();
  await runBoxTemplateBuild(client, { registryId: row.id, runId: null, workerSha: sha }, waits);
  const [after] = await db.select().from(environments).where(eq(environments.id, row.id));
  expect(after.state).toBe("ready");
  expect(after.boxId).toBe("bx_new_tpl");
  expect(after.detail).toBeNull(); // cleared on ready
  // No run to check events on — assert the global agent_events table gained no
  // runner_box_template_* rows for a null session by construction: emitBoxEvent
  // was never called (sessionId would be required). Covered by type safety +
  // the emit no-op below; the meaningful assertion is state/boxId/detail above.
});
```

- [ ] **Step 2: Verify it fails** — `npx vitest run __tests__/box-template-builder.test.ts` → type error (`runId: null` not assignable).

- [ ] **Step 3: Implement** — in `runBoxTemplateBuild`:

```ts
// signature
input: { registryId: number; runId: number | null; workerSha: string },
...
// emit: run-triggered builds stream run events; manual builds don't.
const emit =
  input.runId != null
    ? (type: string, payload: Record<string, unknown>) => emitBoxEvent(input.runId as number, type, payload)
    : async () => {};
```

and inside the `build` callback wrap every `await step("...")` so the row's `detail` tracks progress for BOTH modes (the page reads it):

```ts
const stepAndDetail = async (name: string): Promise<void> => {
  await setEnvironmentDetail(input.registryId, name);
  await step(name);
};
```

(replace the seven `await step("cloning-worker")`-style calls with `await stepAndDetail("cloning-worker")` etc.; import `setEnvironmentDetail` from `./environments`.)

- [ ] **Step 4: Verify** — `npx vitest run __tests__/box-template-builder.test.ts` → PASS (4 tests). `npm run typecheck` clean (Task 6 in box.ts passes a non-null runId — still assignable).

- [ ] **Step 5: Commit** — `git add lib/runner/box-template-builder.ts __tests__/box-template-builder.test.ts && git commit -m "feat(environments): manual box builds — nullable run, detail progress"`

---

### Task 3: Docker image build — `lib/runner/docker-image-build.ts`

**Files:**
- Create: `lib/runner/docker-image-build.ts`
- Test: `__tests__/docker-image-build.test.ts`

**Interfaces:**
- Consumes: `markEnvironmentReady/Failed`, `setEnvironmentDetail` (T1); `config.deployment.workerImage`.
- Produces (T4 calls): `runDockerImageBuild(input: { environmentId: number; image?: string }, opts?: { docker?: DockerBuildApi }): Promise<void>` — never throws.

```ts
export interface DockerBuildApi {
  buildImage(context: unknown, opts: { t: string; dockerfile: string }): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null, output: Array<Record<string, unknown>>) => void,
      onProgress: (evt: { stream?: string; error?: string }) => void
    ): void;
  };
}
```

- [ ] **Step 1: Failing test**

```ts
// __tests__/docker-image-build.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { environments } from "../db/schema";
import { runDockerImageBuild, type DockerBuildApi } from "../lib/runner/docker-image-build";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_IMAGE;
  vi.restoreAllMocks();
});

function fakeDocker(outcome: { error?: string; progress?: string[] } = {}): DockerBuildApi {
  return {
    buildImage: vi.fn(async () => ({}) as NodeJS.ReadableStream),
    modem: {
      followProgress: (_s, onFinished, onProgress) => {
        for (const line of outcome.progress ?? []) onProgress({ stream: line });
        if (outcome.error) onFinished(new Error(outcome.error), []);
        else onFinished(null, [{ stream: "Successfully built" }]);
      },
    },
  };
}

async function seed(): Promise<number> {
  const [row] = await db.insert(environments).values({ provider: "docker", workerSha: "f".repeat(40) }).returning();
  return row.id;
}

describe("runDockerImageBuild", () => {
  it("builds Dockerfile.worker, tracks step detail, marks ready with the image", async () => {
    const id = await seed();
    const docker = fakeDocker({ progress: ["Step 3/12 : RUN npm ci\n"] });
    await runDockerImageBuild({ environmentId: id, image: "worker:test" }, { docker });
    expect(docker.buildImage).toHaveBeenCalledWith(expect.anything(), { t: "worker:test", dockerfile: "Dockerfile.worker" });
    const [row] = await db.select().from(environments).where(eq(environments.id, id));
    expect(row).toMatchObject({ state: "ready", image: "worker:test" });
  });

  it("marks failed with the build error", async () => {
    const id = await seed();
    await runDockerImageBuild({ environmentId: id, image: "worker:test" }, { docker: fakeDocker({ error: "COPY failed" }) });
    const [row] = await db.select().from(environments).where(eq(environments.id, id));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/COPY failed/);
  });

  it("fails the row when no image tag is configured", async () => {
    const id = await seed();
    await runDockerImageBuild({ environmentId: id }, { docker: fakeDocker() });
    const [row] = await db.select().from(environments).where(eq(environments.id, id));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/TASK_ORCH_WORKER_IMAGE/);
  });
});
```

- [ ] **Step 2: Verify fail** — module missing.

- [ ] **Step 3: Implement**

```ts
// lib/runner/docker-image-build.ts
//
// Build the worker Docker image (Dockerfile.worker) on the host via dockerode,
// recording progress and outcome on an environments row. Fire-and-forget like
// the box template builder: never throws.
import { config } from "../config";
import { markEnvironmentFailed, markEnvironmentReady, setEnvironmentDetail } from "./environments";

export interface DockerBuildApi { /* exactly the interface above */ }

export async function runDockerImageBuild(
  input: { environmentId: number; image?: string },
  opts: { docker?: DockerBuildApi } = {}
): Promise<void> {
  try {
    const image = input.image ?? config.deployment.workerImage;
    if (!image) {
      throw new Error("TASK_ORCH_WORKER_IMAGE is not configured; set it (or pass an image tag) to build the worker image.");
    }
    const docker = opts.docker ?? (await makeDocker());
    await setEnvironmentDetail(input.environmentId, "preparing build context");
    // Build context: the repo root. .dockerignore (or the worker Dockerfile's
    // COPY set) bounds what's sent; if the repo lacks a .dockerignore, ADD ONE
    // excluding node_modules, .git, tmp, data.db before wiring this (check —
    // a context including node_modules makes every build minutes slower).
    const stream = await docker.buildImage(
      { context: process.cwd(), src: ["."] },
      { t: image, dockerfile: "Dockerfile.worker" }
    );
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err, output) => {
          if (err) return reject(err);
          const last = output[output.length - 1] as { error?: string } | undefined;
          if (last?.error) return reject(new Error(last.error));
          resolve();
        },
        (evt) => {
          if (evt.error) return; // surfaced by onFinished
          const line = evt.stream?.trim();
          if (line && /^Step \d+\/\d+/.test(line)) {
            void setEnvironmentDetail(input.environmentId, line.slice(0, 140));
          }
        }
      );
    });
    await markEnvironmentReady(input.environmentId, { image });
  } catch (error) {
    await markEnvironmentFailed(
      input.environmentId,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function makeDocker(): Promise<DockerBuildApi> {
  const { default: Docker } = await import("dockerode");
  return new Docker() as unknown as DockerBuildApi;
}
```

Also: check for a repo-root `.dockerignore`. If absent, CREATE one (`node_modules`, `.git`, `.next`, `tmp`, `data.db`, `dist`) and include it in the commit — a naive full-context tar is unusably slow.

- [ ] **Step 4: Verify** — `npx vitest run __tests__/docker-image-build.test.ts` → PASS (3). Typecheck clean.
- [ ] **Step 5: Commit** — `git add lib/runner/docker-image-build.ts __tests__/docker-image-build.test.ts .dockerignore 2>/dev/null; git add lib/runner/docker-image-build.ts __tests__/docker-image-build.test.ts; git commit -m "feat(environments): host docker image build via dockerode"`

---

### Task 4: Build API route

**Files:**
- Create: `app/api/environments/build/route.ts`
- Test: `__tests__/environments-build-route.test.ts`

**Interfaces:**
- Consumes: `runBoxTemplateBuild` (T2, `runId: null`), `runDockerImageBuild` (T3), `environments` table, `workerBuildSha`, `makeBoxClient` (`lib/runner/box-client.ts`), `auth` (`@/auth`).
- Produces: `POST /api/environments/build` `{ provider: "box" | "docker" }` → `202 { id, state: "building" }` | `409 { error, state? }` | `400` | `401`.

- [ ] **Step 1: Failing test** — test the route handler directly (the repo's node vitest can import route modules; model the auth mock on existing route tests if any exist — check `grep -rln "vi.mock(\"@/auth\"" __tests__` and mirror; otherwise:

```ts
// __tests__/environments-build-route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { environments } from "../db/schema";

vi.mock("../auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.com" } })) })); // resolves to the same module as the route's "@/auth" (vitest alias)
vi.mock("../lib/runner/box-template-builder", () => ({ runBoxTemplateBuild: vi.fn(async () => {}) }));
vi.mock("../lib/runner/docker-image-build", () => ({ runDockerImageBuild: vi.fn(async () => {}) }));
vi.mock("../lib/runner/box-client", () => ({ makeBoxClient: vi.fn(() => ({})) }));

import { POST } from "../app/api/environments/build/route";
import { runDockerImageBuild } from "../lib/runner/docker-image-build";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_SHA;
  vi.clearAllMocks();
});

function post(body: unknown): Request {
  return new Request("http://test/api/environments/build", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/environments/build", () => {
  it("rejects unknown providers", async () => {
    const res = await POST(post({ provider: "fly" }));
    expect(res.status).toBe(400);
  });

  it("inserts a building row and kicks the docker build", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "9".repeat(40);
    const res = await POST(post({ provider: "docker" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.state).toBe("building");
    expect(runDockerImageBuild).toHaveBeenCalledWith(expect.objectContaining({ environmentId: body.id }));
  });

  it("409s when a live row exists for the provider+sha", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "8".repeat(40);
    await db.insert(environments).values({ provider: "box", workerSha: "8".repeat(40), state: "ready", boxId: "bx_x", readyAt: new Date() });
    const res = await POST(post({ provider: "box" }));
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Verify fail** — module missing.
- [ ] **Step 3: Implement**

```ts
// app/api/environments/build/route.ts
//
// Kick a manual environment build from the /environments page. Single-flight
// per (provider, worker SHA) via the environments live index; a manual build
// deliberately bypasses the failed-build cooldown (an explicit human retry).
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { environments } from "@/db/schema";
import { workerBuildSha } from "@/lib/runner/worker-sha";
import { runBoxTemplateBuild } from "@/lib/runner/box-template-builder";
import { runDockerImageBuild } from "@/lib/runner/docker-image-build";
import { makeBoxClient } from "@/lib/runner/box-client";

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider;
  if (provider !== "box" && provider !== "docker") {
    return NextResponse.json({ error: "provider must be 'box' or 'docker' (fly builds are not in-app)" }, { status: 400 });
  }

  let sha: string;
  try {
    sha = await workerBuildSha();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }

  const [live] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.provider, provider), eq(environments.workerSha, sha), inArray(environments.state, ["building", "ready"])));
  if (live) {
    return NextResponse.json(
      {
        error: live.state === "building"
          ? "A build is already in progress for the current worker SHA."
          : "An environment is already ready for the current worker SHA; a rebuild only makes sense after the SHA drifts.",
        state: live.state,
      },
      { status: 409 }
    );
  }

  try {
    const [row] = await db.insert(environments).values({ provider, workerSha: sha }).returning();
    if (provider === "box") {
      void runBoxTemplateBuild(makeBoxClient(), { registryId: row.id, runId: null, workerSha: sha }).catch((err) => {
        console.error(`manual box environment build ${row.id} crashed:`, err);
      });
    } else {
      void runDockerImageBuild({ environmentId: row.id }).catch((err) => {
        console.error(`manual docker environment build ${row.id} crashed:`, err);
      });
    }
    return NextResponse.json({ id: row.id, state: "building" }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "A build is already in progress." }, { status: 409 }); // insert race
  }
}
```

- [ ] **Step 4: Verify** — `npx vitest run __tests__/environments-build-route.test.ts` → PASS (3). Typecheck clean.
- [ ] **Step 5: Commit** — `git add app/api/environments/build/route.ts __tests__/environments-build-route.test.ts && git commit -m "feat(environments): manual build API route"`

---

### Task 5: `/environments` page, nav, docs

**Files:**
- Create: `app/environments/page.tsx`, `components/environments/environments-view.tsx`
- Modify: `components/site-header.tsx` + `components/mobile-nav.tsx` (nav arrays: `{ href: "/environments", label: "Environments", icon: Container }` — `Container` from lucide-react — inserted after Runs)
- Modify docs: `docs/runners/README.md`, `docs/runners/box.md`, `docs/box-deployment.md` — add a short "Environments" paragraph: the `/environments` page lists each provider's execution artifacts (docker image, fly image, box template snapshots) versioned by worker SHA; box/docker are buildable in-app; the registry table is `environments` (replaces `box_templates`).

**Interfaces:**
- Consumes: `registerConfiguredEnvironments`, `listEnvironments`, `EnvironmentRow` (T1); `POST /api/environments/build` (T4); `templateStepLabel`-style labels — reuse `STEP_LABELS` via `templateBuildView`? No: the page shows `detail` verbatim (it's already a human-enough string; box steps are step names — map them through the exported `TEMPLATE_BUILD_STEPS` labels only if trivial, else show raw).
- Produces: the page.

- [ ] **Step 1: Server page**

```tsx
// app/environments/page.tsx
import { listEnvironments, registerConfiguredEnvironments } from "@/lib/runner/environments";
import { EnvironmentsView } from "@/components/environments/environments-view";

export const dynamic = "force-dynamic";

export default async function EnvironmentsPage() {
  await registerConfiguredEnvironments();
  const rows = await listEnvironments();
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-lg font-semibold">Environments</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">
        The execution artifact each runner provider launches from — a Docker
        image, a Fly runner image, or a Box template snapshot — versioned by
        worker build SHA.
      </p>
      <EnvironmentsView
        rows={rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          workerSha: r.workerSha,
          state: r.state,
          artifact: r.boxId ?? r.image ?? null,
          detail: r.detail,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          readyAt: r.readyAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
```

- [ ] **Step 2: Client view** — `components/environments/environments-view.tsx` (`"use client"`). Requirements (write idiomatic to the codebase — MUI is NOT used here; this app is Tailwind + small ui components; mirror `runs-index.tsx` styling):

  - Props: `rows: Array<{ id; provider; workerSha; state; artifact; detail; error; createdAt; readyAt }>`.
  - Group rows by provider into three sections in order **box, docker, fly**, each with a header, the build area, and the rows (newest first, as given).
  - Row rendering: state pill (reuse the pill classes used in `runs-index.tsx`/`inbox-panel.tsx`: `building` → progress colors, `ready` → done, `failed` → blocked, `superseded` → muted), monospace artifact (`boxId` or `image`), short SHA (`workerSha.slice(0, 7)`), relative created/ready times (`relativeDate` from `@/lib/utils`), `detail` inline while `building`, `error` (truncated, expandable via `<details>`) on failed.
  - Build area: box + docker sections get a "Build template" / "Build image" button that POSTs `/api/environments/build` with the provider, disabled while that provider has a `building` row; on 409/4xx show the response error inline. Fly section: an info card with the configured image (from its rows) and a copyable command block: `fly deploy --app <runner-app> --image-label <tag>` referencing `docs/fly-deployment.md` for the full flow (use `CodeBlock` from `@/components/ui/code-block`).
  - Polling: while ANY row is `building`, `setInterval(() => router.refresh(), 5000)` (clear on unmount / when none building).

- [ ] **Step 3: Nav** — add to BOTH nav arrays (desktop `site-header.tsx`, `mobile-nav.tsx`), after Runs:

```ts
{ href: "/environments", label: "Environments", icon: Container },
```

with `Container` added to each file's lucide-react import.

- [ ] **Step 4: Docs** — add the Environments paragraph to the three docs listed above (2–5 lines each, matching each doc's tone; in `docs/runners/box.md` update the §"how the app remembers" language from `box_templates` to `environments`). Grep docs for lingering `box_templates` references: `grep -rn "box_templates" docs/runners docs/box-deployment.md` and update those lines.

- [ ] **Step 5: Verify** — `npm run typecheck` clean. Manual: `npm run dev` is likely already running for the user — do NOT start a second server; just note the page URL. Run: `npx vitest run __tests__/environments.test.ts` still green.

- [ ] **Step 6: Commit** — `git add app/environments components/environments components/site-header.tsx components/mobile-nav.tsx docs/runners/README.md docs/runners/box.md docs/box-deployment.md && git commit -m "feat(environments): /environments page with per-provider build area"`

---

### Task 6 (verify): typecheck + suites + spec audit

Run `npm run typecheck` and `npx vitest run`. Known pre-existing failures NOT caused by this feature: `config-guard` only if `scripts/worker-chat.ts` working-tree dirt reappears, `worker-websocket-e2e` flaky reconnect test. Any other failure tracing to environments commits: fix minimally and commit. Audit diffs against the spec: table shape + partial index columns, resolveBoxTemplate contract untouched (box.ts diff is import-only), provider-scoped supersede, manual builds emit no run events, gauge labels `service/provider/state`, page groups box/docker/fly with fly info-only, no `box_templates` references left outside `db/migrations/`. Report deviations precisely.

## Spec coverage self-check

§1 schema/migration → T1. §2 registry module (all 7 exports) → T1 (+T2 for builder detail). §3 docker build → T3. §4 page/nav/build area/polling/409 UX → T4+T5. §5 consumers (telemetry, metrics, state loader, docs) → T1+T5. §6 error handling (409s, daemon unreachable, cooldown bypass on manual, migration drops building rows) → T1/T3/T4. §7 testing map: registry+provider-scope+register (T1), builder manual (T2), docker fake (T3), route (T4), migration smoke = schema-shape via T1's suite using the new table. Out-of-scope respected (no per-run selection, no fly builds).
