# Box Template Build Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 10–15 minute Box template build visible: typed lifecycle events over the existing `emitBoxEvent` → SSE path, a `pending_reason` column so deferred runs explain themselves in the run list, and a template-build stepper inside the existing `StartupIndicator`.

**Architecture:** One new pure module (`lib/runner/box-template-events.ts`) owns the event contract, the client-side event reducer, the render view-model, and the emit-lifecycle driver the future `ensureTemplate()` will call. Persistence changes are one nullable column (`agent_runs.pending_reason`) written by `dispatchRun`'s defer branch and cleared by its claim. UI changes are confined to `run-view.tsx` (SSE wiring) and `startup-indicator.tsx` (rendering).

**Tech Stack:** Next.js / React 18, Drizzle ORM (Postgres), vitest (node environment — **no jsdom/testing-library**, so all testable logic lives in pure functions; components stay thin).

**Spec:** `docs/superpowers/specs/2026-07-17-box-template-build-feedback-design.md` — read it first.

## Global Constraints

- Step names v1: `cloning-worker`, `installing-deps`, `building-worker`, `writing-manifest`, `archiving` — but the UI renders whatever `steps` array the `building` event carries.
- Default estimate: `estimatedSeconds: 900`. Reassurance line appears past `1.5 ×` the estimate.
- Copy (verbatim): title **"Setting up the box template"**; expectation line **"One-time setup for this worker build — usually 10–15 minutes. Later runs skip this."**; reassurance **"Still working — dependency installs can be slow on cold caches"**; failure hint **"Re-dispatching the run retries the build."**
- `lib/runner/box-template-events.ts` must stay importable from client components: no `db`, no server-only imports — pure functions and types only.
- Events ride the existing `emitBoxEvent` path; the SSE client receives them flattened as `{ type: "<event type>", ...payload }` (see `lib/run-stream.ts:50`).
- Tests run with `npx vitest run <file>`; typecheck with `npm run typecheck`.
- Commit after every task (each task's last step).

---

### Task 1: Event contract + client reducer

**Files:**
- Create: `lib/runner/box-template-events.ts`
- Test: `__tests__/box-template-events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2, 5, 6):
  - `TEMPLATE_BUILD_STEPS: readonly string[]`, `type TemplateBuildReason = "no-template" | "sha-drift"`
  - `TEMPLATE_EVENT` constant object with the four event-type strings
  - `interface TemplateBuildState { phase: "building" | "ready" | "failed"; steps: string[]; stepIndex: number; startedAt: number; stepStartedAt: number; estimatedSeconds: number; durationMs?: number; error?: string; failedStep?: string }`
  - `reduceTemplateBuildEvent(state: TemplateBuildState | null, event: Record<string, unknown> & { type: string }, nowMs: number): TemplateBuildState | null`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/box-template-events.test.ts
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_BUILD_STEPS,
  TEMPLATE_EVENT,
  reduceTemplateBuildEvent,
  type TemplateBuildState,
} from "../lib/runner/box-template-events";

const T0 = 1_000_000;

function building(overrides: Record<string, unknown> = {}) {
  return {
    type: TEMPLATE_EVENT.building,
    workerSha: "abc123",
    reason: "no-template",
    steps: [...TEMPLATE_BUILD_STEPS],
    estimatedSeconds: 900,
    ...overrides,
  };
}

describe("reduceTemplateBuildEvent", () => {
  it("starts a build from a building event", () => {
    const s = reduceTemplateBuildEvent(null, building(), T0)!;
    expect(s).toMatchObject({
      phase: "building",
      steps: [...TEMPLATE_BUILD_STEPS],
      stepIndex: -1,
      startedAt: T0,
      stepStartedAt: T0,
      estimatedSeconds: 900,
    });
  });

  it("falls back to the default steps and estimate when the payload omits them", () => {
    const s = reduceTemplateBuildEvent(
      null,
      { type: TEMPLATE_EVENT.building, workerSha: "abc123", reason: "sha-drift" },
      T0
    )!;
    expect(s.steps).toEqual([...TEMPLATE_BUILD_STEPS]);
    expect(s.estimatedSeconds).toBe(900);
  });

  it("advances on step events and stamps stepStartedAt", () => {
    let s = reduceTemplateBuildEvent(null, building(), T0);
    s = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.step, step: "cloning-worker", index: 0, total: 5 },
      T0 + 1_000
    );
    expect(s).toMatchObject({ phase: "building", stepIndex: 0, stepStartedAt: T0 + 1_000 });
  });

  it("keeps stepIndex monotonic when a stale step replays out of order", () => {
    let s = reduceTemplateBuildEvent(null, building(), T0);
    s = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.step, step: "installing-deps", index: 1, total: 5 },
      T0 + 2_000
    );
    const after = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.step, step: "cloning-worker", index: 0, total: 5 },
      T0 + 3_000
    )!;
    expect(after.stepIndex).toBe(1);
    expect(after.stepStartedAt).toBe(T0 + 2_000); // stale event does not restamp
  });

  it("ignores a step event with no preceding building event", () => {
    expect(
      reduceTemplateBuildEvent(
        null,
        { type: TEMPLATE_EVENT.step, step: "cloning-worker", index: 0, total: 5 },
        T0
      )
    ).toBeNull();
  });

  it("ready is terminal and wins over stale steps", () => {
    let s = reduceTemplateBuildEvent(null, building(), T0);
    s = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.ready, templateId: "bx_tpl1", durationMs: 750_000 },
      T0 + 750_000
    );
    expect(s).toMatchObject({ phase: "ready", durationMs: 750_000 });
    const after = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.step, step: "archiving", index: 4, total: 5 },
      T0 + 751_000
    )!;
    expect(after.phase).toBe("ready");
  });

  it("failed captures the failing step and error", () => {
    let s = reduceTemplateBuildEvent(null, building(), T0);
    s = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.failed, step: "installing-deps", error: "npm ci exited 1" },
      T0 + 60_000
    );
    expect(s).toMatchObject({
      phase: "failed",
      failedStep: "installing-deps",
      error: "npm ci exited 1",
    });
  });

  it("a ready replay with no prior state still yields a terminal state", () => {
    const s = reduceTemplateBuildEvent(
      null,
      { type: TEMPLATE_EVENT.ready, templateId: "bx_tpl1", durationMs: 750_000 },
      T0
    )!;
    expect(s.phase).toBe("ready");
    expect(s.stepIndex).toBe(TEMPLATE_BUILD_STEPS.length - 1);
  });

  it("returns the input state untouched for unrelated event types", () => {
    const s = reduceTemplateBuildEvent(null, building(), T0);
    expect(reduceTemplateBuildEvent(s, { type: "runner_box_forking" }, T0 + 1)).toBe(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/box-template-events.test.ts`
Expected: FAIL — cannot resolve `../lib/runner/box-template-events`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/runner/box-template-events.ts
//
// The Box template-build feedback contract (spec:
// docs/superpowers/specs/2026-07-17-box-template-build-feedback-design.md).
// Shared by the server emitter (ensureTemplate, via emitTemplateBuildLifecycle)
// and the run view (reducer + view model), so it must stay pure: no db, no
// server-only imports.

export const TEMPLATE_BUILD_STEPS = [
  "cloning-worker",
  "installing-deps",
  "building-worker",
  "writing-manifest",
  "archiving",
] as const;

export type TemplateBuildReason = "no-template" | "sha-drift";

export const TEMPLATE_EVENT = {
  building: "runner_box_template_building",
  step: "runner_box_template_step",
  ready: "runner_box_template_ready",
  failed: "runner_box_template_failed",
} as const;

export const TEMPLATE_BUILD_DEFAULT_ESTIMATE_SECONDS = 900;

export interface TemplateBuildState {
  phase: "building" | "ready" | "failed";
  steps: string[];
  /** -1 before the first step event. */
  stepIndex: number;
  /** Client receipt time (ms) of the building event. */
  startedAt: number;
  /** Client receipt time (ms) of the latest step advance. */
  stepStartedAt: number;
  estimatedSeconds: number;
  durationMs?: number;
  error?: string;
  failedStep?: string;
}

/**
 * Fold one SSE event (the flat `{ type, ...payload }` shape produced by
 * lib/run-stream.ts) into the build state. Tolerates replays and out-of-order
 * delivery: stepIndex is monotonic, terminal phases win over stale steps, and
 * a step with no preceding building event is ignored.
 */
export function reduceTemplateBuildEvent(
  state: TemplateBuildState | null,
  event: Record<string, unknown> & { type: string },
  nowMs: number
): TemplateBuildState | null {
  switch (event.type) {
    case TEMPLATE_EVENT.building: {
      const steps = Array.isArray(event.steps) && event.steps.length > 0
        ? (event.steps as string[])
        : [...TEMPLATE_BUILD_STEPS];
      const estimatedSeconds =
        typeof event.estimatedSeconds === "number" && event.estimatedSeconds > 0
          ? event.estimatedSeconds
          : TEMPLATE_BUILD_DEFAULT_ESTIMATE_SECONDS;
      return {
        phase: "building",
        steps,
        stepIndex: -1,
        startedAt: nowMs,
        stepStartedAt: nowMs,
        estimatedSeconds,
      };
    }
    case TEMPLATE_EVENT.step: {
      if (!state || state.phase !== "building") return state;
      const index = typeof event.index === "number" ? event.index : state.stepIndex;
      if (index <= state.stepIndex) return state; // stale replay
      return { ...state, stepIndex: index, stepStartedAt: nowMs };
    }
    case TEMPLATE_EVENT.ready: {
      const base = state ?? initialTerminalState(nowMs);
      return {
        ...base,
        phase: "ready",
        stepIndex: base.steps.length - 1,
        durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      };
    }
    case TEMPLATE_EVENT.failed: {
      const base = state ?? initialTerminalState(nowMs);
      return {
        ...base,
        phase: "failed",
        failedStep: typeof event.step === "string" ? event.step : undefined,
        error: typeof event.error === "string" ? event.error : "Template build failed",
      };
    }
    default:
      return state;
  }
}

/** A reconnect can replay only the terminal event; synthesize a base state. */
function initialTerminalState(nowMs: number): TemplateBuildState {
  return {
    phase: "building",
    steps: [...TEMPLATE_BUILD_STEPS],
    stepIndex: -1,
    startedAt: nowMs,
    stepStartedAt: nowMs,
    estimatedSeconds: TEMPLATE_BUILD_DEFAULT_ESTIMATE_SECONDS,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/box-template-events.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-template-events.ts __tests__/box-template-events.test.ts
git commit -m "feat(box-template): event contract and client build-state reducer"
```

---

### Task 2: Emit-lifecycle driver for `ensureTemplate()`

**Files:**
- Modify: `lib/runner/box-template-events.ts` (append)
- Test: `__tests__/box-template-events.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `TEMPLATE_EVENT`, `TEMPLATE_BUILD_STEPS`, `TemplateBuildReason` (Task 1).
- Produces (called by the future `ensureTemplate()` with `emit = (type, payload) => emitBoxEvent(runId, type, payload)`):

```ts
emitTemplateBuildLifecycle<T extends { templateId: string }>(opts: {
  emit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  workerSha: string;
  reason: TemplateBuildReason;
  steps?: readonly string[];          // defaults to TEMPLATE_BUILD_STEPS
  estimatedSeconds?: number;          // defaults to 900
  now?: () => number;                 // injectable clock for tests
  build: (step: (name: string) => Promise<void>) => Promise<T>;
}): Promise<T>
```

- [ ] **Step 1: Write the failing test**

Append to `__tests__/box-template-events.test.ts`:

```ts
import { emitTemplateBuildLifecycle } from "../lib/runner/box-template-events";

describe("emitTemplateBuildLifecycle", () => {
  function collector() {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    return {
      events,
      emit: async (type: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
      },
    };
  }

  it("emits building → each step with index/total → ready with templateId and duration", async () => {
    const c = collector();
    let t = 0;
    const result = await emitTemplateBuildLifecycle({
      emit: c.emit,
      workerSha: "abc123",
      reason: "no-template",
      steps: ["cloning-worker", "installing-deps"],
      now: () => (t += 1_000),
      build: async (step) => {
        await step("cloning-worker");
        await step("installing-deps");
        return { templateId: "bx_tpl1" };
      },
    });

    expect(result).toEqual({ templateId: "bx_tpl1" });
    expect(c.events.map((e) => e.type)).toEqual([
      TEMPLATE_EVENT.building,
      TEMPLATE_EVENT.step,
      TEMPLATE_EVENT.step,
      TEMPLATE_EVENT.ready,
    ]);
    expect(c.events[0].payload).toMatchObject({
      workerSha: "abc123",
      reason: "no-template",
      steps: ["cloning-worker", "installing-deps"],
      estimatedSeconds: 900,
    });
    expect(c.events[1].payload).toEqual({ step: "cloning-worker", index: 0, total: 2 });
    expect(c.events[2].payload).toEqual({ step: "installing-deps", index: 1, total: 2 });
    expect(c.events[3].payload).toMatchObject({ templateId: "bx_tpl1" });
    expect(typeof c.events[3].payload.durationMs).toBe("number");
  });

  it("emits failed with the current step and rethrows on build error", async () => {
    const c = collector();
    await expect(
      emitTemplateBuildLifecycle({
        emit: c.emit,
        workerSha: "abc123",
        reason: "sha-drift",
        steps: ["cloning-worker", "installing-deps"],
        build: async (step) => {
          await step("cloning-worker");
          await step("installing-deps");
          throw new Error("npm ci exited 1");
        },
      })
    ).rejects.toThrow("npm ci exited 1");
    const last = c.events[c.events.length - 1];
    expect(last.type).toBe(TEMPLATE_EVENT.failed);
    expect(last.payload).toMatchObject({ step: "installing-deps", error: "npm ci exited 1" });
  });

  it("rejects a step name not declared in steps", async () => {
    const c = collector();
    await expect(
      emitTemplateBuildLifecycle({
        emit: c.emit,
        workerSha: "abc123",
        reason: "no-template",
        steps: ["cloning-worker"],
        build: async (step) => {
          await step("mystery-step");
          return { templateId: "bx_tpl1" };
        },
      })
    ).rejects.toThrow(/not declared/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/box-template-events.test.ts`
Expected: FAIL — `emitTemplateBuildLifecycle` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/runner/box-template-events.ts`:

```ts
/**
 * Drive a template build while emitting the lifecycle contract. The future
 * ensureTemplate() wraps its build in this with
 * `emit = (type, payload) => emitBoxEvent(runId, type, payload)`; the contract
 * (building → step(index/total)… → ready | failed) is enforced here so every
 * caller emits the exact sequence the run view's reducer expects.
 *
 * Emission is awaited but the emitter itself must be non-throwing (emitBoxEvent
 * already swallows persistence errors); a build failure is emitted as `failed`
 * and then rethrown so the caller's error handling still runs.
 */
export async function emitTemplateBuildLifecycle<T extends { templateId: string }>(opts: {
  emit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  workerSha: string;
  reason: TemplateBuildReason;
  steps?: readonly string[];
  estimatedSeconds?: number;
  now?: () => number;
  build: (step: (name: string) => Promise<void>) => Promise<T>;
}): Promise<T> {
  const steps = opts.steps ?? TEMPLATE_BUILD_STEPS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let currentStep: string | undefined;

  await opts.emit(TEMPLATE_EVENT.building, {
    workerSha: opts.workerSha,
    reason: opts.reason,
    steps: [...steps],
    estimatedSeconds: opts.estimatedSeconds ?? TEMPLATE_BUILD_DEFAULT_ESTIMATE_SECONDS,
  });

  const step = async (name: string): Promise<void> => {
    const index = steps.indexOf(name);
    if (index === -1) throw new Error(`Template build step "${name}" is not declared in steps.`);
    currentStep = name;
    await opts.emit(TEMPLATE_EVENT.step, { step: name, index, total: steps.length });
  };

  try {
    const result = await opts.build(step);
    await opts.emit(TEMPLATE_EVENT.ready, {
      templateId: result.templateId,
      durationMs: now() - startedAt,
    });
    return result;
  } catch (error) {
    await opts.emit(TEMPLATE_EVENT.failed, {
      step: currentStep,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/box-template-events.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-template-events.ts __tests__/box-template-events.test.ts
git commit -m "feat(box-template): emitTemplateBuildLifecycle driver with contract tests"
```

---

### Task 3: `pending_reason` column + dispatch wiring

**Files:**
- Create: `db/migrations/0019_pending_reason.sql`
- Modify: `db/migrations/meta/_journal.json` (append an entry)
- Modify: `db/schema.ts` (agent_runs table, after `parkReason` at ~line 286)
- Modify: `lib/run-dispatch.ts` (defer branch ~line 543, claim update ~line 588)
- Test: `__tests__/pending-reason.test.ts`

**Interfaces:**
- Consumes: `providerDecision.reason` (already returned by `BoxRunnerProvider.admit` / `boxAdmissionDecision`).
- Produces: `agentSessions.pendingReason` column (used by Task 4). Defer writes the provider reason (fallback `"Waiting for runner capacity."`); the atomic claim clears it.

- [ ] **Step 1: Write the migration**

```sql
-- db/migrations/0019_pending_reason.sql
-- Why a 'pending' run is pending (admission defer reason: template build,
-- capacity, account backpressure). Mirrors park_reason for parked runs.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "pending_reason" text;
```

Append to the `entries` array in `db/migrations/meta/_journal.json` (after the `0018_tool_invoke_payload` entry):

```json
    {
      "idx": 19,
      "version": "7",
      "when": 1784648000000,
      "tag": "0019_pending_reason",
      "breakpoints": true
    }
```

- [ ] **Step 2: Add the schema column**

In `db/schema.ts`, directly after the `parkReason` line (~286):

```ts
    // Why a 'pending' run is pending: the admission defer reason (template
    // build, capacity, account backpressure). Written on defer, cleared on
    // claim. Mirrors parkReason for parked runs.
    pendingReason: text("pending_reason"),
```

- [ ] **Step 3: Write the failing test**

```ts
// __tests__/pending-reason.test.ts
// Spec §2: a deferred run is never a bare 'pending' — admission's defer reason
// is persisted to agent_runs.pending_reason, and the atomic claim clears it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";

const KNOBS = ["TASK_ORCH_RUNNER", "TASK_ORCH_WORKER_IMAGE"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  vi.restoreAllMocks();
});

async function pendingReasonOf(runId: number): Promise<string | null> {
  const [row] = await db
    .select({ pendingReason: agentSessions.pendingReason })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId));
  return row?.pendingReason ?? null;
}

describe("pending_reason", () => {
  it("persists the provider defer reason when admission defers", async () => {
    process.env.TASK_ORCH_RUNNER = "box";
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test"; // keep placement on the worker path
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, {
      providerAdmit: async () => ({ decision: "defer", reason: "Building box template…" }),
    });
    expect(result).toBe("deferred");
    expect(await pendingReasonOf(run.id)).toBe("Building box template…");
  });

  it("falls back to a generic reason when the defer carries none", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, { spawn: vi.fn(() => 1), admit: () => "defer" });
    expect(result).toBe("deferred");
    expect(await pendingReasonOf(run.id)).toBe("Waiting for runner capacity.");
  });

  it("clears the reason when the run is admitted and claimed", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });
    await dispatchRun(run.id, { spawn: vi.fn(() => 1), admit: () => "defer" });
    expect(await pendingReasonOf(run.id)).not.toBeNull();

    const result = await dispatchRun(run.id, { spawn: vi.fn(() => 1), admit: () => "admit" });
    expect(result).toBe("spawned");
    expect(await pendingReasonOf(run.id)).toBeNull();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run __tests__/pending-reason.test.ts`
Expected: FAIL — `pendingReason` is not written (first assertion gets `null`). (If the schema column step was skipped it fails earlier with an unknown-column select error.)

- [ ] **Step 5: Wire the reason through `dispatchRun`**

In `lib/run-dispatch.ts`, inside the `gateActive` block (~line 498), capture the reason. Change:

```ts
      let decision: AdmitDecision;
      if (opts.admit) {
        decision = await opts.admit(runId);
      } else if (lightweightChild) {
        decision = await lightweightAdmit(runId);
      } else {
        const reservedActive = await runs().countInFlightWorkers();
        const providerDecision = await (opts.providerAdmit ?? providerAdmit)({ runId, reservedActive });
        if (providerDecision.decision === "reject") {
          await runs().failRun(runId, providerDecision.message);
          return { kind: "spawn-failed" };
        }
        decision = providerDecision.decision;
      }
```

to:

```ts
      let decision: AdmitDecision;
      let deferReason: string | null = null;
      if (opts.admit) {
        decision = await opts.admit(runId);
      } else if (lightweightChild) {
        decision = await lightweightAdmit(runId);
      } else {
        const reservedActive = await runs().countInFlightWorkers();
        const providerDecision = await (opts.providerAdmit ?? providerAdmit)({ runId, reservedActive });
        if (providerDecision.decision === "reject") {
          await runs().failRun(runId, providerDecision.message);
          return { kind: "spawn-failed" };
        }
        decision = providerDecision.decision;
        if (providerDecision.decision === "defer") deferReason = providerDecision.reason ?? null;
      }
```

In the defer branch (~line 555), add `pendingReason` to the update:

```ts
        await db
          .update(agentSessions)
          .set({
            status: "pending",
            workerScope: null,
            workerPid: null,
            // Spec §2: pending is never bare — persist why admission deferred.
            pendingReason: deferReason ?? "Waiting for runner capacity.",
            ...(stampEpisode ? { heartbeatAt: new Date() } : {}),
          })
          .where(eq(agentSessions.id, runId));
```

In the atomic claim update (~line 588), add the clear alongside the other prior-attempt artifact clears:

```ts
        status: "preparing",
        workerScope: scope,
        cancelRequested: 0,
        heartbeatAt: new Date(),
        workerLog: null,
        workerExitCode: null,
        error: null,
        completedAt: null,
        pendingReason: null,
```

- [ ] **Step 6: Apply the migration to the dev/test database and run the test**

Run: `npx vitest run __tests__/pending-reason.test.ts`

If the test DB is provisioned from migrations automatically (check `vitest.setup.ts`), this just passes. If it errors with `column "pending_reason" does not exist`, apply the migration the same way 0016–0018 are applied in this repo (see `vitest.setup.ts` / `db/index.ts` for how the test schema is built), then re-run.
Expected: PASS (3 tests).

- [ ] **Step 7: Run the neighboring suites to catch regressions**

Run: `npx vitest run __tests__/admission-children.test.ts __tests__/dispatch-routing.test.ts __tests__/lightweight-child.test.ts __tests__/box-admission.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/0019_pending_reason.sql db/migrations/meta/_journal.json db/schema.ts lib/run-dispatch.ts __tests__/pending-reason.test.ts
git commit -m "feat(dispatch): persist admission defer reason as pending_reason"
```

---

### Task 4: Surface `pending_reason` in the run list

**Files:**
- Modify: `lib/run-index.ts` (`RunIndexRow`, ~line 77 next to `parkReason`)
- Modify: `lib/run-overview.ts` (row mapping, ~line 45)
- Modify: `components/runs/runs-index.tsx` (`EventBadges`, ~line 478)
- Test: `__tests__/pending-reason.test.ts` (append)

**Interfaces:**
- Consumes: `agentSessions.pendingReason` (Task 3).
- Produces: `RunIndexRow.pendingReason: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/pending-reason.test.ts`:

```ts
import { getRunOverview } from "../lib/run-overview";

describe("run overview", () => {
  it("serializes pendingReason onto RunIndexRow", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db
      .update(agentSessions)
      .set({ status: "pending", pendingReason: "Building box template…" })
      .where(eq(agentSessions.id, run.id));
    const rows = await getRunOverview();
    const row = rows.find((r) => r.id === run.id)!;
    expect(row.pendingReason).toBe("Building box template…");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/pending-reason.test.ts`
Expected: FAIL — `pendingReason` is `undefined` on the row (and typecheck would reject it).

- [ ] **Step 3: Implement**

In `lib/run-index.ts`, next to `parkReason: string | null;` (~line 77), add:

```ts
  pendingReason: string | null;
```

In `lib/run-overview.ts`, next to `parkReason: r.parkReason,` (~line 45), add:

```ts
    pendingReason: r.pendingReason,
```

(If the overview `select` enumerates columns rather than selecting whole rows, add `pendingReason: agentSessions.pendingReason` there too.)

In `components/runs/runs-index.tsx`, extend `EventBadges` (~line 478) — same pattern as the `parked` line, progress-colored because pending is forward motion, not a block:

```tsx
function EventBadges({ run }: { run: RunIndexRow }) {
  return (
    <>
      {run.status === "parked" && run.parkReason && (
        <span className="text-[11px] text-state-review">{run.parkReason}</span>
      )}
      {run.status === "pending" && run.pendingReason && (
        <span className="text-[11px] text-state-progress">{run.pendingReason}</span>
      )}
      {run.pendingEvents > 0 && (
        ...unchanged...
      )}
    </>
  );
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run __tests__/pending-reason.test.ts && npm run typecheck`
Expected: PASS / clean. (If typecheck reports other call sites constructing `RunIndexRow` literals — e.g. the overview SSE route or tests — add `pendingReason: null` there.)

- [ ] **Step 5: Commit**

```bash
git add lib/run-index.ts lib/run-overview.ts components/runs/runs-index.tsx __tests__/pending-reason.test.ts
git commit -m "feat(runs-index): show pending_reason under the status pill"
```

---

### Task 5: Render view-model (pure, fully tested)

**Files:**
- Modify: `lib/runner/box-template-events.ts` (append)
- Test: `__tests__/box-template-events.test.ts` (append)

**Interfaces:**
- Consumes: `TemplateBuildState` (Task 1).
- Produces (consumed by Task 6's component):

```ts
interface TemplateBuildStepView { step: string; label: string; state: "done" | "active" | "todo" | "failed"; elapsedSeconds?: number }
interface TemplateBuildView {
  phase: "building" | "ready" | "failed";
  title: string;
  expectation: string;
  elapsedLabel: string;        // "12m 40s" style, overall
  showReassurance: boolean;
  reassurance: string;
  steps: TemplateBuildStepView[];
  readyLabel?: string;         // `Template ready (12m 40s)` on ready
  error?: string;
  failureHint: string;
}
templateBuildView(state: TemplateBuildState, nowMs: number): TemplateBuildView
formatDuration(ms: number): string   // 40_000 → "40s", 760_000 → "12m 40s"
```

- [ ] **Step 1: Write the failing test**

Append to `__tests__/box-template-events.test.ts`:

```ts
import { formatDuration, templateBuildView } from "../lib/runner/box-template-events";

describe("templateBuildView", () => {
  const base: TemplateBuildState = {
    phase: "building",
    steps: ["cloning-worker", "installing-deps", "building-worker"],
    stepIndex: 1,
    startedAt: T0,
    stepStartedAt: T0 + 120_000,
    estimatedSeconds: 900,
  };

  it("labels steps and marks done/active/todo with per-step elapsed", () => {
    const v = templateBuildView(base, T0 + 180_000);
    expect(v.title).toBe("Setting up the box template");
    expect(v.expectation).toBe(
      "One-time setup for this worker build — usually 10–15 minutes. Later runs skip this."
    );
    expect(v.elapsedLabel).toBe("3m 0s");
    expect(v.steps).toEqual([
      { step: "cloning-worker", label: "Cloning worker repo", state: "done" },
      { step: "installing-deps", label: "Installing dependencies", state: "active", elapsedSeconds: 60 },
      { step: "building-worker", label: "Building worker", state: "todo" },
    ]);
    expect(v.showReassurance).toBe(false);
  });

  it("falls back to the raw step name for unknown steps", () => {
    const v = templateBuildView({ ...base, steps: ["mystery-step"], stepIndex: 0 }, T0 + 1_000);
    expect(v.steps[0].label).toBe("mystery-step");
  });

  it("shows reassurance past 1.5× the estimate", () => {
    const v = templateBuildView(base, T0 + 900_000 * 1.5 + 1_000);
    expect(v.showReassurance).toBe(true);
    expect(v.reassurance).toBe("Still working — dependency installs can be slow on cold caches");
  });

  it("collapses to a ready label with the build duration", () => {
    const v = templateBuildView({ ...base, phase: "ready", stepIndex: 2, durationMs: 760_000 }, T0 + 760_000);
    expect(v.readyLabel).toBe("Template ready (12m 40s)");
  });

  it("marks the failing step and carries the error and hint", () => {
    const v = templateBuildView(
      { ...base, phase: "failed", failedStep: "installing-deps", error: "npm ci exited 1" },
      T0 + 300_000
    );
    expect(v.steps[1].state).toBe("failed");
    expect(v.error).toBe("npm ci exited 1");
    expect(v.failureHint).toBe("Re-dispatching the run retries the build.");
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatDuration(40_000)).toBe("40s");
    expect(formatDuration(760_000)).toBe("12m 40s");
    expect(formatDuration(0)).toBe("0s");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/box-template-events.test.ts`
Expected: FAIL — `templateBuildView` / `formatDuration` not exported.

- [ ] **Step 3: Implement**

Append to `lib/runner/box-template-events.ts`:

```ts
const STEP_LABELS: Record<string, string> = {
  "cloning-worker": "Cloning worker repo",
  "installing-deps": "Installing dependencies",
  "building-worker": "Building worker",
  "writing-manifest": "Writing manifest",
  "archiving": "Archiving snapshot",
};

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export interface TemplateBuildStepView {
  step: string;
  label: string;
  state: "done" | "active" | "todo" | "failed";
  elapsedSeconds?: number;
}

export interface TemplateBuildView {
  phase: TemplateBuildState["phase"];
  title: string;
  expectation: string;
  elapsedLabel: string;
  showReassurance: boolean;
  reassurance: string;
  steps: TemplateBuildStepView[];
  readyLabel?: string;
  error?: string;
  failureHint: string;
}

/** Everything the stepper renders, computed here so it is unit-testable
 *  without a DOM (this repo's vitest runs in node, no jsdom). */
export function templateBuildView(state: TemplateBuildState, nowMs: number): TemplateBuildView {
  const steps: TemplateBuildStepView[] = state.steps.map((step, i) => {
    if (state.phase === "failed" && step === state.failedStep) {
      return { step, label: STEP_LABELS[step] ?? step, state: "failed" };
    }
    const done = state.phase === "ready" || i < state.stepIndex;
    const active = state.phase === "building" && i === state.stepIndex;
    return {
      step,
      label: STEP_LABELS[step] ?? step,
      state: done ? "done" : active ? "active" : "todo",
      ...(active ? { elapsedSeconds: Math.floor((nowMs - state.stepStartedAt) / 1000) } : {}),
    };
  });

  return {
    phase: state.phase,
    title: "Setting up the box template",
    expectation:
      "One-time setup for this worker build — usually 10–15 minutes. Later runs skip this.",
    elapsedLabel: formatDuration(nowMs - state.startedAt),
    showReassurance:
      state.phase === "building" && nowMs - state.startedAt > state.estimatedSeconds * 1000 * 1.5,
    reassurance: "Still working — dependency installs can be slow on cold caches",
    steps,
    ...(state.phase === "ready" && state.durationMs != null
      ? { readyLabel: `Template ready (${formatDuration(state.durationMs)})` }
      : {}),
    ...(state.error ? { error: state.error } : {}),
    failureHint: "Re-dispatching the run retries the build.",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/box-template-events.test.ts`
Expected: PASS (all suites in the file).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-template-events.ts __tests__/box-template-events.test.ts
git commit -m "feat(box-template): pure render view-model for the build stepper"
```

---

### Task 6: Wire SSE + render the stepper

**Files:**
- Modify: `components/runs/run-view.tsx` (state ~line 130s, `handleSseEvent` ~line 300, `StartupIndicator` render site ~line 802)
- Modify: `components/runs/startup-indicator.tsx`

**Interfaces:**
- Consumes: `reduceTemplateBuildEvent`, `templateBuildView`, `TemplateBuildState` (Tasks 1, 5).
- Produces: `StartupIndicator` gains an optional prop `templateBuild?: TemplateBuildState | null`.

No new unit tests (no DOM test rig); all logic was tested in Tasks 1 and 5. Verification is typecheck + full suite + a manual replay check.

- [ ] **Step 1: Reduce template events in `run-view.tsx`**

Add imports:

```ts
import {
  reduceTemplateBuildEvent,
  type TemplateBuildState,
} from "@/lib/runner/box-template-events";
```

Add state next to the other `useState` hooks:

```ts
const [templateBuild, setTemplateBuild] = useState<TemplateBuildState | null>(null);
```

At the TOP of `handleSseEvent` (before the `status` branch — template frames arrive as flat `{ type: "runner_box_template_…", ...payload }` events forwarded verbatim by the events route):

```ts
    const raw = event as unknown as Record<string, unknown> & { type: string };
    if (raw.type.startsWith("runner_box_template_")) {
      setTemplateBuild((prev) => reduceTemplateBuildEvent(prev, raw, Date.now()));
      return;
    }
```

- [ ] **Step 2: Extend the indicator render condition**

The template build happens while the run is deferred — before any send/first-token state the current condition depends on. Replace the render site (~line 802):

```tsx
            {sending &&
              (awaitingFirstToken ? (
                <StartupIndicator ... />
              ) : (
                <ThinkingIndicator />
              ))}
```

with:

```tsx
            {(() => {
              const buildVisible =
                templateBuild != null &&
                templateBuild.phase !== "ready" &&
                (status === "pending" || status === "preparing");
              if (!sending && !buildVisible) return null;
              if (awaitingFirstToken || buildVisible) {
                return (
                  <StartupIndicator
                    runtime={run.runtime}
                    status={status}
                    templateBuild={templateBuild}
                    onShowLog={
                      run.runtime === "worker"
                        ? () => setShowWorkerLog(true)
                        : undefined
                    }
                  />
                );
              }
              return <ThinkingIndicator />;
            })()}
```

(`phase === "ready"` drops the standalone indicator once the build completes and the normal boot arc takes over inside the stepper; a `failed` build stays visible while the run is still pending so the error is readable until the run's own failure state lands.)

- [ ] **Step 3: Render the template phase in `startup-indicator.tsx`**

Extend the props and imports:

```ts
import { Check, ScrollText, X } from "lucide-react";
import {
  templateBuildView,
  type TemplateBuildState,
} from "@/lib/runner/box-template-events";

interface Props {
  runtime: "server" | "worker";
  status: SessionStatus;
  /** Live template-build state (spec 2026-07-17); non-null only while a box
   *  template is being built/failed for this run's dispatch. */
  templateBuild?: TemplateBuildState | null;
  onShowLog?: () => void;
}
```

In the component body, before the `booting` branch: the template build phase supersedes the plain boot list whenever it is active or failed (a ready build falls through to the normal boot arc, with a collapsed "done" line):

```tsx
export function StartupIndicator({ runtime, status, templateBuild, onShowLog }: Props) {
  const elapsed = useElapsedSeconds();
  const elapsedLabel = elapsed >= 3 ? `${elapsed}s` : null;

  if (templateBuild && templateBuild.phase !== "ready") {
    // The 1s elapsed tick above re-renders us every second, so computing the
    // view with Date.now() at render keeps all timers live.
    const v = templateBuildView(templateBuild, Date.now());
    const failed = v.phase === "failed";
    return (
      <div className="mx-4 my-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
        <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
          {failed ? (
            <X className="size-3 text-state-blocked" />
          ) : (
            <Spinner className="size-3 text-state-progress" />
          )}
          <span>{v.title}</span>
          <span className="tabular-nums font-normal text-muted-foreground/70">
            {v.elapsedLabel}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground/70">{v.expectation}</p>

        <ol className="mt-2 space-y-1">
          {v.steps.map((step) => (
            <li
              key={step.step}
              className={cn(
                "flex items-center gap-2 text-[11px]",
                step.state === "done" && "text-muted-foreground/70",
                step.state === "active" && "text-foreground",
                step.state === "failed" && "text-state-blocked",
                step.state === "todo" && "text-muted-foreground/40"
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {step.state === "done" ? (
                  <Check className="size-3 text-state-done" />
                ) : step.state === "active" ? (
                  <Spinner className="size-3 text-state-progress" />
                ) : step.state === "failed" ? (
                  <X className="size-3 text-state-blocked" />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              <span>{step.label}</span>
              {step.elapsedSeconds != null && step.elapsedSeconds >= 3 && (
                <span className="tabular-nums text-muted-foreground/70">
                  {step.elapsedSeconds}s
                </span>
              )}
            </li>
          ))}
        </ol>

        {v.showReassurance && (
          <p className="mt-2 text-[11px] text-muted-foreground/70">{v.reassurance}</p>
        )}
        {failed && (
          <div className="mt-2 text-[11px] text-state-blocked">
            <pre className="whitespace-pre-wrap font-mono">{v.error}</pre>
            <p className="mt-1 text-muted-foreground/70">{v.failureHint}</p>
          </div>
        )}
      </div>
    );
  }

  // ...existing booting / calm-line logic, unchanged, EXCEPT:
```

And in the existing `booting` branch's step list, insert a collapsed done-line ABOVE the `<ol>` when a completed build is present, so the story reads continuously (template done → boot continues):

```tsx
      {templateBuild?.phase === "ready" && (
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground/70">
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <Check className="size-3 text-state-done" />
          </span>
          <span>{templateBuildView(templateBuild, Date.now()).readyLabel ?? "Template ready"}</span>
        </div>
      )}
```

- [ ] **Step 4: Typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: clean typecheck; all tests pass.

- [ ] **Step 5: Manual replay check**

With the dev server running (`npm run dev`) and a worker-runtime run open, inject the lifecycle into `agent_events` for that run id (psql or a tsx one-liner) and watch the run view:

```ts
// npx tsx --eval '...' — adjust RUN_ID
import { db } from "./db";
import { agentEvents } from "./db/schema";
const RUN_ID = 1;
const emit = (type: string, payload: object) =>
  db.insert(agentEvents).values({ sessionId: RUN_ID, type, payload: JSON.stringify(payload), createdAt: new Date() });
await emit("runner_box_template_building", { workerSha: "abc", reason: "no-template", steps: ["cloning-worker","installing-deps","building-worker","writing-manifest","archiving"], estimatedSeconds: 900 });
await new Promise(r => setTimeout(r, 3000));
await emit("runner_box_template_step", { step: "cloning-worker", index: 0, total: 5 });
await new Promise(r => setTimeout(r, 3000));
await emit("runner_box_template_step", { step: "installing-deps", index: 1, total: 5 });
await new Promise(r => setTimeout(r, 3000));
await emit("runner_box_template_ready", { templateId: "bx_tpl1", durationMs: 9000 });
```

Expected: stepper appears with title/expectation, steps advance with timers, collapses to "Template ready (9s)" when the run is in the boot arc. Repeat with a `runner_box_template_failed` event to see the failed state.

- [ ] **Step 6: Commit**

```bash
git add components/runs/run-view.tsx components/runs/startup-indicator.tsx
git commit -m "feat(run-view): render the box template build stepper from SSE events"
```

---

## Spec coverage self-check

- Spec §1 event contract → Tasks 1–2 (types, defaults, driver enforcing order/index/total/failed-step).
- Spec §2 pending_reason → Tasks 3–4 (column, defer write incl. fallback, claim clear, RunIndexRow, EventBadges). The exact strings "Building box template…" / "Waiting for box template build (started by run #N)" are supplied by the future `ensureTemplate()` defer path as `providerDecision.reason` — the mechanism landing here carries them verbatim.
- Spec §3 stepper → Tasks 5–6 (copy, per-step elapsed, reassurance at 1.5×, ready collapse, failed state + hint, log button untouched).
- Spec §4 concurrent runs → Task 3/4 reason line (no stepper) — matches the stated v1 limitation.
- Spec §5 error handling → reducer tolerance tests (Task 1), failed-event flow (Tasks 1, 5, 6).
- Spec §6 testing → reducer tests (T1), contract test (T2), pending_reason write/clear tests (T3), overview serialization (T4), view-model tests (T5).
