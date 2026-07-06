# Child Follow-up Remote Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow-up turns sent to a child run from inside a Fly worker (e.g. an executor's `spawn__append_message`) must dispatch onto the child's own Machine instead of running inline in the parent's worker process.

**Architecture:** The remote-append path already exists (`sendMessageToRun` + the "BUG M3" branch in `lib/extensions/spawn.ts`), but it is gated on `remoteRunnerEnabled()`, which is always **false inside a Fly worker** — workers receive neither `TASK_ORCH_RUNNER` nor `TASK_ORCH_WORKER_IMAGE` (deliberately: they hold no Fly token). The sanctioned handed-down signal is `TASK_ORCH_INSIDE_WORKER=1` + `TASK_ORCH_NESTED_DISPATCH=isolate` (see `buildFlyWorkerEnv`, `lib/runner/fly.ts:285`). Fix in two moves: (1) make `remoteRunnerEnabled()` honor that signal, and (2) inside such a worker, `sendMessageToRun` must not call `dispatchRun` (no Fly credentials) — instead park the target run at `status='pending'` exactly like `launchDetached` does for child *creation* (`lib/runs.ts:647-661`): the pending row IS the dispatch request; the server's pump (`pumpTick` → `listPendingRunIds`) claims it and resumes the child's own Machine.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Vitest. No new dependencies.

## Global Constraints

- Preserve the `sendMessageToRun` INVARIANT (documented at `lib/extensions/spawn.ts:777`): the user message is persisted AND the dispatch (or defer) is completed **before the generator's first yield**.
- A run holding a **live worker claim** (`workerScope` set + heartbeat fresher than 5 min) must never be parked to `pending` — the in-flight turn drains the freshly persisted message itself (same semantics as `dispatchRun` returning `already-claimed`).
- Match existing test conventions: env-var save/restore per test (see `__tests__/nested-dispatch.test.ts:19-27`), `create({ goal, defer: true })` for fixture runs, `vi.spyOn(dispatch, "dispatchRun")`.
- Do not pass `TASK_ORCH_RUNNER` or a Fly token into workers — `lib/runner/provider.ts:77-80` documents why that is forbidden.
- Incident context (evidence this fixes a real production failure): runs #40/#41 and #43/#50/#57/#58 on 2026-07-05/06 — child follow-up turns ran inline in the parent's 4 GB Machine, wedged it under build tooling (typecheck OOM), and the stale-lease reaper failed parent + all in-flight children together.

---

### Task 1: `remoteRunnerEnabled()` honors the isolate-worker signal

**Files:**
- Modify: `lib/run-dispatch.ts:13` (import) and `lib/run-dispatch.ts:84-87` (function)
- Test: `__tests__/nested-dispatch.test.ts`

**Interfaces:**
- Consumes: `insideWorker()`, `nestedDispatchMode()` from `lib/runner/provider.ts` (already re-exported at `lib/run-dispatch.ts:76`).
- Produces: `remoteRunnerEnabled(): boolean` — now `true` inside a worker whose nested-dispatch policy is `isolate`, unchanged everywhere else. Task 2 and the existing call sites (`lib/runs.ts:2418`, `lib/extensions/spawn.ts:764`, `lib/extensions/events.ts:189`, `lib/runs.ts:3441`) rely on this.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe` block of `__tests__/nested-dispatch.test.ts` (its `beforeEach`/`afterEach` already save/restore `TASK_ORCH_NESTED_DISPATCH`, `TASK_ORCH_INSIDE_WORKER`, and related keys — extend `ENV_KEYS` there if `TASK_ORCH_RUNNER` / `TASK_ORCH_WORKER_IMAGE` / `TASK_ORCH_DETACHED_RUNS` are not already in the list):

```ts
import { remoteRunnerEnabled } from "../lib/run-dispatch";

describe("remoteRunnerEnabled inside workers", () => {
  it("treats an isolate-mode worker as remote (appends must never run in-process there)", () => {
    // A Fly worker: gets INSIDE_WORKER + NESTED_DISPATCH from buildFlyWorkerEnv,
    // but deliberately NOT TASK_ORCH_RUNNER / TASK_ORCH_WORKER_IMAGE.
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
    delete process.env.TASK_ORCH_RUNNER;
    delete process.env.TASK_ORCH_WORKER_IMAGE;
    delete process.env.TASK_ORCH_DETACHED_RUNS;

    expect(remoteRunnerEnabled()).toBe(true);
  });

  it("keeps an inline-mode worker on the in-process path", () => {
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    process.env.TASK_ORCH_NESTED_DISPATCH = "inline";
    delete process.env.TASK_ORCH_RUNNER;
    delete process.env.TASK_ORCH_WORKER_IMAGE;
    delete process.env.TASK_ORCH_DETACHED_RUNS;

    expect(remoteRunnerEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/nested-dispatch.test.ts`
Expected: FAIL — first new test gets `false`, expected `true` (second may pass already; that is fine).

- [ ] **Step 3: Implement**

In `lib/run-dispatch.ts`, extend the provider import at line 13:

```ts
import { getRunnerProvider, runnerProviderKindFromEnv, insideWorker, nestedDispatchMode } from "./runner/provider";
```

(The `export { insideWorker, nestedDispatchMode, ... }` re-export at line 76 stays; converting it to re-export the now-imported names or leaving it as-is both work — keep whichever compiles without a duplicate-identifier error, i.e. change line 76 to `export { insideWorker, nestedDispatchMode };` plus keep the `export type { NestedDispatchMode } from "./runner/provider";`.)

Replace `remoteRunnerEnabled` (line 84-87):

```ts
/** True when the server must route user turns through an out-of-process runner.
 *  Also true INSIDE an isolate-mode worker: there, turns are remote by policy —
 *  the worker holds no Fly credentials, so append paths must defer to the
 *  server (see runs.sendMessageToRun) rather than drive a child in-process.
 *  Workers never receive TASK_ORCH_RUNNER / TASK_ORCH_WORKER_IMAGE (see
 *  lib/runner/provider.ts:77), so the env-based check alone is always false
 *  in exactly the environment that most needs the remote path. */
export function remoteRunnerEnabled(): boolean {
  if (insideWorker() && nestedDispatchMode() === "isolate") return true;
  return detachedRunsEnabled() && (runnerProviderKindFromEnv() === "fly" || !!process.env.TASK_ORCH_WORKER_IMAGE);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/nested-dispatch.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — expected exit 0.

```bash
git add lib/run-dispatch.ts __tests__/nested-dispatch.test.ts
git commit -m "fix(dispatch): isolate-mode workers count as remote-runner deployments"
```

---

### Task 2: Worker-side defer in `sendMessageToRun` (park at pending, don't dispatch)

**Files:**
- Modify: `lib/runs.ts` — imports (line 38), new exported helper next to `launchDetached`/`emitRunnerDeferred` (~line 661), and the two dispatch call sites inside `sendMessageToRun` (~lines 2434-2454)
- Test: `__tests__/send-message-defer.test.ts` (create)

**Interfaces:**
- Consumes: `remoteRunnerEnabled()` from Task 1; `runDispatch.insideWorker()`, `runDispatch.nestedDispatchMode()` (namespace import `runDispatch` already exists in runs.ts); `emitRunnerDeferred(runId, parentRunId)` (`lib/runs.ts:668`); `HEARTBEAT_STALE_MS` (`lib/runs.ts`, exported).
- Produces: `deferRunForServerDispatch(runId: number, parentRunId: number | null): Promise<boolean>` — parks a claim-free run at `pending` (stamping `heartbeatAt`, clearing `workerScope`/`workerPid`) and emits `runner_deferred`; returns `false` (no-op) when a live claim holds the row. `sendMessageToRun` behavior change: inside an isolate worker, both the dead-chat branch and the non-chat branch call this instead of `dispatchRun`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/send-message-defer.test.ts`:

```ts
// __tests__/send-message-defer.test.ts
//
// Follow-up messages sent from INSIDE an isolate-mode worker (a parent
// executor doing spawn__append_message) must not drive the child's turn
// in-process (the worker has no Fly credentials and shares its 4GB Machine),
// and must not call dispatchRun (same credential problem). Instead the child
// row is parked at 'pending' — the dispatch request the SERVER's pump picks
// up, resuming the child's own Machine. Mirrors launchDetached's isolate
// deferral for child CREATION (docs/nested-machine-dispatch.md).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { agentEvents, agentSessions } from "../db/schema";
import { create, get, sendMessageToRun } from "../lib/runs";
import * as dispatch from "../lib/run-dispatch";

const ENV_KEYS = [
  "TASK_ORCH_INSIDE_WORKER",
  "TASK_ORCH_NESTED_DISPATCH",
  "TASK_ORCH_RUNNER",
  "TASK_ORCH_WORKER_IMAGE",
  "TASK_ORCH_DETACHED_RUNS",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function workerIsolateEnv() {
  process.env.TASK_ORCH_INSIDE_WORKER = "1";
  process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
}

/** Pull exactly one frame (persist+defer happen before the first yield), then close. */
async function fireAppend(runId: number, text: string) {
  const abort = new AbortController();
  const gen = sendMessageToRun({ runId, role: "user", text, abort });
  await gen.next();
  abort.abort();
  await gen.return(undefined as never).catch(() => {});
}

describe("sendMessageToRun inside an isolate-mode worker", () => {
  it("parks a finished implement child at 'pending' instead of dispatching", async () => {
    workerIsolateEnv();
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "completed", branch: "claude/t-x-1", sdkSessionId: "sess-1" })
      .where(eq(agentSessions.id, run.id));

    await fireAppend(run.id, "resume: push the branch and open the PR");

    const after = await get(run.id);
    expect(after?.status).toBe("pending"); // the dispatch request for the server pump
    expect(after?.heartbeatAt).not.toBeNull(); // pending-episode stamp (MAX_DEFER_MS clock)
    expect(spy).not.toHaveBeenCalled(); // workers must never dispatch
    const deferred = await db.select().from(agentEvents)
      .where(and(eq(agentEvents.sessionId, run.id), eq(agentEvents.type, "runner_deferred")))
      .orderBy(desc(agentEvents.id)).limit(1);
    expect(deferred.length).toBe(1);
  });

  it("leaves a child with a LIVE worker claim untouched (its turn drains the message)", async () => {
    workerIsolateEnv();
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "running", workerScope: "run-live-1", heartbeatAt: new Date() })
      .where(eq(agentSessions.id, run.id));

    await fireAppend(run.id, "additional guidance mid-turn");

    const after = await get(run.id);
    expect(after?.status).toBe("running"); // NOT parked
    expect(after?.workerScope).toBe("run-live-1"); // claim intact
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("sendMessageToRun on the server (unchanged behavior)", () => {
  it("still dispatches via dispatchRun", async () => {
    // Remote deployment seen from the SERVER: worker-image mode.
    process.env.TASK_ORCH_WORKER_IMAGE = "orch-worker:test";
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "completed", branch: "claude/t-x-2", sdkSessionId: "sess-2" })
      .where(eq(agentSessions.id, run.id));

    await fireAppend(run.id, "server-side follow-up");

    expect(spy).toHaveBeenCalledWith(run.id);
    expect((await get(run.id))?.status).toBe("completed"); // parking is worker-only
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/send-message-defer.test.ts`
Expected: FAIL — first test: status is `"completed"` (or `dispatchRun` was called), not `"pending"`. Third test should PASS already (it pins current behavior). If the first test instead hangs on `gen.next()`, the abort in `fireAppend` is wrong — fix the test before touching production code.

- [ ] **Step 3: Implement the helper and wire it in**

In `lib/runs.ts` line 38, add `lt` and `or` to the drizzle import:

```ts
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
```

Add below `emitRunnerDeferred` (~line 679):

```ts
/**
 * Park a run at 'pending' as a dispatch request for the SERVER's pump — the
 * worker-side counterpart of dispatchRun for FOLLOW-UP messages, mirroring
 * launchDetached's isolate deferral for child creation (the pending row IS the
 * dispatch request; docs/nested-machine-dispatch.md Decision 1). A worker holds
 * no Fly credentials, so it must never dispatch/resume Machines itself.
 *
 * Guarded single conditional UPDATE: a row with a live claim (workerScope set
 * AND heartbeat fresher than HEARTBEAT_STALE_MS) is left alone — the in-flight
 * turn drains the freshly persisted message, same as dispatchRun's
 * "already-claimed". heartbeatAt is stamped because pumpTick measures the
 * pending episode from it (TASK_ORCH_MAX_DEFER_MS).
 */
export async function deferRunForServerDispatch(
  runId: number,
  parentRunId: number | null
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const parked = await db.update(agentSessions)
    .set({ status: "pending", heartbeatAt: new Date(), workerScope: null, workerPid: null })
    .where(and(
      eq(agentSessions.id, runId),
      or(
        isNull(agentSessions.workerScope),
        isNull(agentSessions.heartbeatAt),
        lt(agentSessions.heartbeatAt, staleBefore)
      )
    ))
    .returning({ id: agentSessions.id });
  if (parked.length === 0) return false;
  await emitRunnerDeferred(runId, parentRunId);
  return true;
}
```

In `sendMessageToRun` (~lines 2434-2454), branch both dispatch sites. Before the `if (fresh)` block compute:

```ts
  const workerIsolate = runDispatch.insideWorker() && runDispatch.nestedDispatchMode() === "isolate";
```

Chat branch — replace the body of `if (!isWorkerLive(fresh)) { ... }` with:

```ts
      if (!isWorkerLive(fresh)) {
        if (workerIsolate) {
          // Worker context: no Fly credentials — park the row for the server's
          // pump instead of dispatching (deferRunForServerDispatch re-checks the
          // claim atomically, so the isWorkerLive read above going stale is safe).
          await deferRunForServerDispatch(runId, run.parentRunId ?? null);
        } else {
          // Clear a dead worker's stale claim so dispatchRun can re-claim (idle chat
          // rows aren't a lease status, so reconcile never cleared it).
          if (fresh.workerScope) {
            await db
              .update(agentSessions)
              .set({ workerScope: null, workerPid: null })
              .where(eq(agentSessions.id, runId));
          }
          await runDispatch.dispatchRun(runId);
        }
      }
```

Non-chat branch — replace `await runDispatch.dispatchRun(runId);` (the one under the "Non-chat follow-up" comment) with:

```ts
      if (workerIsolate) {
        // Worker context (e.g. an executor's spawn__append_message): park the
        // child at 'pending' for the server to dispatch onto the child's OWN
        // Machine. Running this turn in-process would put the child's build
        // tooling inside the parent's Machine — the 2026-07-05 incident where
        // one typecheck OOM wedged the parent and every in-flight child.
        await deferRunForServerDispatch(runId, run.parentRunId ?? null);
      } else {
        await runDispatch.dispatchRun(runId);
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/send-message-defer.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Run the neighboring suites (regression check)**

Run: `npx vitest run __tests__/nested-dispatch.test.ts __tests__/run-dispatch.test.ts __tests__/runs-claim-release.test.ts __tests__/reconcile-orphaned-runs.test.ts __tests__/pipe-commands.test.ts`
Expected: all pass EXCEPT the one pre-existing failure in `runs-claim-release.test.ts` ("clears worker_scope/worker_pid after a single-turn drive completes") — that failure exists on clean `main` and is out of scope; anything else failing is a regression from this task.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit` — expected exit 0.

```bash
git add lib/runs.ts __tests__/send-message-defer.test.ts
git commit -m "fix(runs): worker-side appends defer to the server instead of dispatching"
```

---

### Task 3: Documentation truth-up and full verification

**Files:**
- Modify: `lib/extensions/spawn.ts:753-763` (the BUG M3 comment)
- Modify: `docs/nested-machine-dispatch.md` (add a short "follow-up turns" note; find the decision list and append)
- Test: none (comment/doc only) — full suite as the gate

**Interfaces:**
- Consumes: behavior implemented in Tasks 1-2.
- Produces: nothing programmatic; prevents the next reader from believing follow-ups still run inline on Fly.

- [ ] **Step 1: Update the M3 comment in `lib/extensions/spawn.ts`**

Append to the existing comment block (after "...in-process path below is kept for dev / non-remote mode."):

```ts
        // Inside an isolate-mode WORKER, remoteRunnerEnabled() is also true
        // (run-dispatch honors TASK_ORCH_INSIDE_WORKER + TASK_ORCH_NESTED_DISPATCH),
        // and sendMessageToRun parks the child at 'pending' for the SERVER to
        // dispatch onto the child's own Machine instead of calling dispatchRun —
        // a worker holds no Fly credentials (deferRunForServerDispatch in lib/runs.ts).
```

- [ ] **Step 2: Add the follow-up note to `docs/nested-machine-dispatch.md`**

Locate the decisions section (grep for `Decision 6`) and append after the last decision:

```markdown
## Follow-up turns (2026-07-06)

Child *creation* deferral (Decision 1) alone was not enough: a parent
executor's `spawn__append_message` to a finished child used to fall into the
in-process append path inside Fly workers, because `remoteRunnerEnabled()`
could not see the worker context (workers get neither `TASK_ORCH_RUNNER` nor
`TASK_ORCH_WORKER_IMAGE`). The child's follow-up turn then ran inside the
parent's Machine — one child's typecheck OOM wedged the parent and every
in-flight sibling (incident 2026-07-05, runs #40/#41 and #43/#50/#57/#58).

Now: `remoteRunnerEnabled()` is true inside isolate-mode workers, and
`sendMessageToRun` in a worker parks the target run at `pending`
(`deferRunForServerDispatch`) — the same "pending row is the dispatch
request" contract as creation. The server's pump claims it and resumes the
child's own Machine (suspended Machines resume; destroyed ones re-clone from
the pushed branch and fall back to a fresh SDK session).
```

- [ ] **Step 3: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck exit 0; test summary shows exactly ONE failed test — the pre-existing `runs-claim-release.test.ts` failure present on clean `main`. Any other failure is a regression: stop and fix before committing.

- [ ] **Step 4: Commit**

```bash
git add lib/extensions/spawn.ts docs/nested-machine-dispatch.md
git commit -m "docs: record worker-side follow-up deferral in nested-dispatch design"
```

---

## Out of scope (known follow-ups, do NOT fold in)

1. **Lifecycle suspend churn:** `lib/runner/lifecycle.ts:136` suspends a revivable child's Machine ~1 s after each completed turn; with this plan the resume path makes that merely a latency cost. An exemption for revivable children whose parent tree is still active is a separate optimization.
2. **`worker_scope` never re-claimed per follow-up turn** — the pre-existing failing test on `main` (`runs-claim-release.test.ts`, "BUG 1"). Separate fix.
3. **Silent heartbeat-write failures** (`touchHeartbeat` swallows errors) — separate observability fix.
