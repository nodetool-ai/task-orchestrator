# Detached Run Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent runs survive a redeploy — a `systemctl restart` of the web service must never kill an in-flight run.

**Architecture:** Relocate turn execution out of the web-server process into a per-run detached systemd scope (`systemd-run --user --scope`), so a web restart cannot signal it. Clients stream by tailing the already-incrementally-persisted `agent_messages` / `agent_events` tables by monotonic-id cursor instead of an in-process event bus. Cancel becomes a DB flag the worker polls. Boot recovery reuses the existing DB-heartbeat + `reconcileOrphanedRuns()` machinery, re-dispatching resumable orphans instead of failing them.

**Tech Stack:** TypeScript, Next.js (App Router, route handlers), better-sqlite3 + Drizzle ORM, Vitest, `@anthropic-ai/claude-agent-sdk` (active backend), tsx, systemd `--user` units.

**Design doc:** `docs/superpowers/specs/2026-07-02-detached-run-workers-design.md`

## Global Constraints

- Everything behind feature flag `TASK_ORCH_DETACHED_RUNS`. Flag off ⇒ today's in-process behavior, unchanged. Read it via `process.env.TASK_ORCH_DETACHED_RUNS` and treat any non-empty value except `"0"`/`"false"` as on.
- DB access: import the shared singleton `db` from `@/db` (alias) or `../db` (scripts/tests). Schema tables live in `@/db/schema`; note the runs table is exported as `agentSessions` (aliased; DB table name is `agent_runs`).
- Migrations: numbered `db/migrations/NNNN_name.sql`, applied in filename sort order by `applyMigrations()` in `db/index.ts`. Next number is `0020`. Plain `ALTER TABLE ... ADD COLUMN`; the runner tolerates re-applied ADD COLUMN.
- WAL is already enabled (`db/index.ts:115`). Do not re-toggle.
- Tests: Vitest. `npx vitest run <file>` for one file. Follow the existing pattern in `__tests__/reconcile-orphaned-runs.test.ts` (import `db`, `create()`, mutate with drizzle, assert via `get()`).
- Preserve the existing SSE frame contract consumed by the run view: status frames are `JSON.parse(payload)` of an `agent_events` row (e.g. `{type:"status",status:"running"}`); the terminal sentinel is `{type:"_eos"}`.
- Do not rewrite turn logic. `runReview` / `runExecute` / `kickoffFirstTurn` / `runOneTurn` in `lib/runs.ts` stay as-is except where a task says otherwise.
- Commit after every task. Conventional commit messages. Co-author trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Phase 1 — DB-tail streaming (ships independently, flag-independent)

This phase replaces the in-process event bus in the read-only SSE endpoint with a DB tail. It is correct even while runs still execute in-process, so it ships first and de-risks the rest.

### Task 1: `readStreamSince` — pure cursor tail

**Files:**
- Create: `lib/run-stream.ts`
- Test: `__tests__/run-stream.test.ts`

**Interfaces:**
- Produces:
  - `type StreamCursor = { msgId: number; evtId: number }`
  - `type StreamFrame = { kind: "event"; id: number; at: number; data: unknown } | { kind: "message"; id: number; at: number; message: MessageRow }`
  - `function readStreamSince(runId: number, cursor: StreamCursor): { frames: StreamFrame[]; cursor: StreamCursor; terminal: boolean }`
  - `const ZERO_CURSOR: StreamCursor = { msgId: 0, evtId: 0 }`
- Consumes: `db` from `../db`; `agentMessages`, `agentEvents` from `../db/schema`; `hydrateMessage` + `MessageRow` — export `hydrateMessage` from `lib/runs.ts` if not already exported, else re-implement the row→MessageRow shaping inside `run-stream.ts` (check `lib/runs.ts` `hydrateMessage`/`MessageRow` first and reuse).
- `terminal` is true when any emitted `event` frame has `data.type === "status"` and `isTerminalStatus(data.status)` and `data.status !== "idle"` (import `isTerminalStatus` from `@/lib/types`).

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/run-stream.test.ts
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { agentMessages, agentEvents } from "../db/schema";
import { create } from "../lib/runs";
import { readStreamSince, ZERO_CURSOR } from "../lib/run-stream";

function addEvent(runId: number, payload: object) {
  db.insert(agentEvents)
    .values({ sessionId: runId, type: "status", payload: JSON.stringify(payload), createdAt: new Date() })
    .run();
}
function addMessage(runId: number, role: string, text: string) {
  db.insert(agentMessages)
    .values({ runId, role, content: JSON.stringify([{ type: "text", text }]), createdAt: new Date() })
    .run();
}

describe("readStreamSince", () => {
  it("returns nothing for an empty run and a non-terminal verdict", () => {
    const run = create({ goal: "<chat>", defer: true });
    const r = readStreamSince(run.id, ZERO_CURSOR);
    expect(r.frames).toEqual([]);
    expect(r.terminal).toBe(false);
    expect(r.cursor).toEqual(ZERO_CURSOR);
  });

  it("emits new message and event frames and advances both cursors", () => {
    const run = create({ goal: "<chat>", defer: true });
    addEvent(run.id, { type: "status", status: "running" });
    addMessage(run.id, "agent", "hello");
    const r = readStreamSince(run.id, ZERO_CURSOR);
    expect(r.frames.map((f) => f.kind)).toEqual(["event", "message"]);
    expect(r.cursor.evtId).toBeGreaterThan(0);
    expect(r.cursor.msgId).toBeGreaterThan(0);
    expect(r.terminal).toBe(false);
  });

  it("does not re-emit rows at or below the cursor", () => {
    const run = create({ goal: "<chat>", defer: true });
    addMessage(run.id, "agent", "one");
    const first = readStreamSince(run.id, ZERO_CURSOR);
    addMessage(run.id, "agent", "two");
    const second = readStreamSince(run.id, first.cursor);
    expect(second.frames).toHaveLength(1);
    expect((second.frames[0] as any).message.content[0].text).toBe("two");
  });

  it("flags terminal on a non-idle terminal status event", () => {
    const run = create({ goal: "<implement>", defer: true });
    addEvent(run.id, { type: "status", status: "failed", error: "boom" });
    const r = readStreamSince(run.id, ZERO_CURSOR);
    expect(r.terminal).toBe(true);
  });

  it("does NOT flag terminal on idle", () => {
    const run = create({ goal: "<chat>", defer: true });
    addEvent(run.id, { type: "status", status: "idle" });
    expect(readStreamSince(run.id, ZERO_CURSOR).terminal).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/run-stream.test.ts`
Expected: FAIL — cannot resolve `../lib/run-stream`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/run-stream.ts
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { agentMessages, agentEvents } from "../db/schema";
import { isTerminalStatus, type SessionStatus } from "./types";
import { hydrateMessage, type MessageRow } from "./runs";

export type StreamCursor = { msgId: number; evtId: number };
export const ZERO_CURSOR: StreamCursor = { msgId: 0, evtId: 0 };

export type StreamFrame =
  | { kind: "event"; id: number; at: number; data: unknown }
  | { kind: "message"; id: number; at: number; message: MessageRow };

export function readStreamSince(
  runId: number,
  cursor: StreamCursor
): { frames: StreamFrame[]; cursor: StreamCursor; terminal: boolean } {
  const evts = db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, runId), gt(agentEvents.id, cursor.evtId)))
    .orderBy(asc(agentEvents.id))
    .all();
  const msgs = db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.runId, runId), gt(agentMessages.id, cursor.msgId)))
    .orderBy(asc(agentMessages.id))
    .all();

  const frames: StreamFrame[] = [];
  let terminal = false;
  for (const e of evts) {
    let data: unknown = {};
    try { data = JSON.parse(e.payload); } catch { data = { type: "raw", payload: e.payload }; }
    const d = data as { type?: string; status?: SessionStatus };
    if (d.type === "status" && d.status && isTerminalStatus(d.status) && d.status !== "idle") {
      terminal = true;
    }
    frames.push({ kind: "event", id: e.id, at: e.createdAt.getTime(), data });
  }
  for (const m of msgs) {
    frames.push({ kind: "message", id: m.id, at: m.createdAt.getTime(), message: hydrateMessage(m) });
  }
  frames.sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.id - b.id : a.kind === "event" ? -1 : 1));

  return {
    frames,
    cursor: {
      evtId: evts.length ? evts[evts.length - 1].id : cursor.evtId,
      msgId: msgs.length ? msgs[msgs.length - 1].id : cursor.msgId,
    },
    terminal,
  };
}
```

If `hydrateMessage` / `MessageRow` are not exported from `lib/runs.ts`, add `export` to their declarations (they are internal helpers; exporting is safe and used nowhere conflicting).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/run-stream.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/run-stream.ts __tests__/run-stream.test.ts lib/runs.ts
git commit -m "feat(runs): add readStreamSince DB tail for run streaming

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2: SSE endpoint tails the DB

**Files:**
- Modify: `app/api/runs/[id]/events/route.ts` (full rewrite of the stream body)
- Test: manual (Next route; the tail logic is covered by Task 1)

**Interfaces:**
- Consumes: `readStreamSince`, `ZERO_CURSOR`, `StreamCursor` from `@/lib/run-stream`; `runs.get`.
- Client may pass `?msgCursor=&evtCursor=` to resume; default `ZERO_CURSOR`.
- Emits SSE frames: for `kind:"event"` send `frame.data` verbatim (preserves today's `{type:"status",...}` contract); for `kind:"message"` send `{ type: "message", message: frame.message }`. On terminal send `{type:"_eos"}` then close. Include a `{type:"_cursor", cursor}` frame after each batch so the client can resume.

- [ ] **Step 1: Rewrite the route**

```ts
// app/api/runs/[id]/events/route.ts
import { type NextRequest } from "next/server";
import * as runs from "@/lib/runs";
import { readStreamSince, ZERO_CURSOR, type StreamCursor } from "@/lib/run-stream";

export const dynamic = "force-dynamic";

const POLL_ACTIVE_MS = 150;
const POLL_IDLE_MS = 1000;
const IDLE_BACKOFF_AFTER = 20; // empty polls before backing off

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId)) return new Response("Bad id", { status: 400 });
  if (!runs.get(runId)) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  let cursor: StreamCursor = {
    msgId: parseInt(url.searchParams.get("msgCursor") ?? "", 10) || ZERO_CURSOR.msgId,
    evtId: parseInt(url.searchParams.get("evtCursor") ?? "", 10) || ZERO_CURSOR.evtId,
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (o: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`)); }
        catch { closed = true; }
      };
      const ping = () => { if (!closed) { try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch { closed = true; } } };

      req.signal.addEventListener("abort", () => { closed = true; try { controller.close(); } catch {} });

      let emptyPolls = 0;
      let sinceLastPing = 0;
      while (!closed) {
        const { frames, cursor: next, terminal } = readStreamSince(runId, cursor);
        cursor = next;
        if (frames.length) {
          emptyPolls = 0;
          for (const f of frames) {
            if (f.kind === "event") send(f.data);
            else send({ type: "message", message: f.message });
          }
          send({ type: "_cursor", cursor });
        } else {
          emptyPolls++;
        }
        if (terminal) { send({ type: "_eos" }); break; }
        const wait = emptyPolls >= IDLE_BACKOFF_AFTER ? POLL_IDLE_MS : POLL_ACTIVE_MS;
        sinceLastPing += wait;
        if (sinceLastPing >= 15000) { ping(); sinceLastPing = 0; }
        await new Promise((r) => setTimeout(r, wait));
      }
      try { controller.close(); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 2: Verify the client still renders**

Run: `npm run dev`, open a run detail page, start/observe a run. Confirm status transitions and streamed assistant/tool messages appear. If the run view's SSE handler doesn't yet understand `{type:"message", message}`, add a branch in its `onmessage` that appends `message` to the run's message list (locate the consumer with `grep -rn "EventSource\|/events" components app | grep -i run`). Confirm `{type:"_eos"}` still closes the view.

- [ ] **Step 3: Typecheck + full test suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/runs/ components/
git commit -m "feat(runs): stream run events by tailing the DB instead of the in-process bus

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Schema + dispatch scaffolding (behind the flag)

### Task 3: migration + schema columns

**Files:**
- Create: `db/migrations/0020_detached_run_workers.sql`
- Modify: `db/schema.ts` (add three columns to the runs table + note index)
- Test: `__tests__/detached-schema.test.ts`

**Interfaces:**
- Produces columns on `agent_runs`: `worker_scope TEXT`, `worker_pid INTEGER`, `cancel_requested INTEGER`. Drizzle fields: `workerScope`, `workerPid`, `cancelRequested`.
- Produces indexes `idx_agent_messages_run_id` on `agent_messages(run_id, id)` and `idx_agent_events_run_id` on `agent_events(session_id, id)`.

- [ ] **Step 1: Write the migration**

```sql
-- db/migrations/0020_detached_run_workers.sql
-- Detached run workers: identity + cross-process cancel + tail indexes.
ALTER TABLE agent_runs ADD COLUMN worker_scope TEXT;
ALTER TABLE agent_runs ADD COLUMN worker_pid INTEGER;
ALTER TABLE agent_runs ADD COLUMN cancel_requested INTEGER;
CREATE INDEX IF NOT EXISTS idx_agent_messages_run_id ON agent_messages (run_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_id ON agent_events (session_id, id);
```

- [ ] **Step 2: Add the Drizzle columns**

In `db/schema.ts`, on the runs table definition (the one mapping to `agent_runs`, exported as `agentSessions`), add alongside `heartbeatAt`:

```ts
  workerScope: text("worker_scope"),
  workerPid: integer("worker_pid"),
  cancelRequested: integer("cancel_requested"),
```

- [ ] **Step 3: Write the failing test**

```ts
// __tests__/detached-schema.test.ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";

describe("detached run worker columns", () => {
  it("persists worker identity and cancel flag", () => {
    const run = create({ goal: "<chat>", defer: true });
    db.update(agentSessions)
      .set({ workerScope: "run-1-abc", workerPid: 4242, cancelRequested: 1 })
      .where(eq(agentSessions.id, run.id))
      .run();
    const row = get(run.id)!;
    expect(row.workerScope).toBe("run-1-abc");
    expect(row.workerPid).toBe(4242);
    expect(row.cancelRequested).toBe(1);
  });
});
```

If `get()` / `RunRow` don't surface the new fields, extend `hydrateRun` in `lib/runs.ts` to map them (search `hydrateRun` and add the three fields mirroring `heartbeatAt`).

- [ ] **Step 4: Run test**

Run: `npx vitest run __tests__/detached-schema.test.ts`
Expected: PASS (migration auto-applies on DB open).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0020_detached_run_workers.sql db/schema.ts lib/runs.ts __tests__/detached-schema.test.ts
git commit -m "feat(db): add worker identity + cancel columns and tail indexes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: `dispatchRun` — claim + spawn strategy

**Files:**
- Create: `lib/run-dispatch.ts`
- Test: `__tests__/run-dispatch.test.ts`

**Interfaces:**
- Produces:
  - `function dispatchRun(runId: number, opts?: { spawn?: SpawnFn }): "spawned" | "already-claimed" | "not-found"`
  - `type SpawnFn = (runId: number, scope: string) => number | null` — returns the child pid (or null). Injectable so tests don't spawn processes. Default = `defaultSpawn` (below).
  - `function detachedRunsEnabled(): boolean` — reads `TASK_ORCH_DETACHED_RUNS`.
- Claim rule: dispatch only if the run is not currently leased (`isLeaseLive` false) and `workerScope` is null (not already claimed). Claim = set `status:"preparing"`, `workerScope: "run-<id>-<nonce>"`, `cancelRequested: 0`, `heartbeatAt: new Date()` in one `db.update`, guarded so a concurrent claimer loses (see step 3).
- Consumes: `db`, `agentSessions`, `get`, `isLeaseLive` from `lib/runs`.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/run-dispatch.test.ts
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";

describe("dispatchRun", () => {
  it("claims an unclaimed run and calls spawn once", () => {
    const run = create({ goal: "<implement>", taskId: null as any, defer: true });
    const spawn = vi.fn(() => 5555);
    const result = dispatchRun(run.id, { spawn });
    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    const row = get(run.id)!;
    expect(row.status).toBe("preparing");
    expect(row.workerScope).toMatch(/^run-\d+-/);
    expect(row.workerPid).toBe(5555);
  });

  it("is idempotent — a second dispatch does not spawn again", () => {
    const run = create({ goal: "<implement>", defer: true });
    dispatchRun(run.id, { spawn: () => 1 });
    const spawn2 = vi.fn(() => 2);
    expect(dispatchRun(run.id, { spawn: spawn2 })).toBe("already-claimed");
    expect(spawn2).not.toHaveBeenCalled();
  });

  it("returns not-found for a missing run", () => {
    expect(dispatchRun(999999, { spawn: () => 1 })).toBe("not-found");
  });

  it("does not dispatch a run holding a live lease", () => {
    const run = create({ goal: "<implement>", defer: true });
    db.update(agentSessions)
      .set({ status: "running", heartbeatAt: new Date() })
      .where(eq(agentSessions.id, run.id))
      .run();
    expect(dispatchRun(run.id, { spawn: () => 1 })).toBe("already-claimed");
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run __tests__/run-dispatch.test.ts`
Expected: FAIL — cannot resolve `../lib/run-dispatch`.

- [ ] **Step 3: Implement**

```ts
// lib/run-dispatch.ts
import { and, eq, isNull } from "drizzle-orm";
import { spawn as nodeSpawn } from "node:child_process";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { get, isLeaseLive } from "./runs";

export type SpawnFn = (runId: number, scope: string) => number | null;

export function detachedRunsEnabled(): boolean {
  const v = process.env.TASK_ORCH_DETACHED_RUNS;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

// Monotonic per-process nonce (Math.random is unavailable in some sandboxes;
// a counter + pid is unique enough for a scope unit name).
let nonceCounter = 0;
function nonce(): string {
  nonceCounter += 1;
  return `${process.pid}-${nonceCounter}`;
}

export function dispatchRun(
  runId: number,
  opts: { spawn?: SpawnFn } = {}
): "spawned" | "already-claimed" | "not-found" {
  const run = get(runId);
  if (!run) return "not-found";
  if (isLeaseLive(run)) return "already-claimed";
  if (run.workerScope) return "already-claimed";

  const scope = `run-${runId}-${nonce()}`;
  // Atomic claim: only succeeds if worker_scope is still NULL. A concurrent
  // claimer that wins flips it non-null, so our WHERE matches 0 rows and we bail.
  const claimed = db
    .update(agentSessions)
    .set({ status: "preparing", workerScope: scope, cancelRequested: 0, heartbeatAt: new Date() })
    .where(and(eq(agentSessions.id, runId), isNull(agentSessions.workerScope)))
    .run();
  if (claimed.changes === 0) return "already-claimed";

  const spawn = opts.spawn ?? defaultSpawn;
  const pid = spawn(runId, scope);
  if (pid != null) {
    db.update(agentSessions).set({ workerPid: pid }).where(eq(agentSessions.id, runId)).run();
  }
  return "spawned";
}

// M1: launch the worker in its own transient systemd --user scope so a
// `systemctl restart` of the web unit cannot signal it. Falls back to a
// plain detached spawn (dev / no systemd-run). Returns the child pid.
export const defaultSpawn: SpawnFn = (runId, scope) => {
  const node = process.execPath;
  const tsx = require.resolve("tsx/cli");
  const worker = "scripts/run-worker.ts";
  const useSystemd = process.platform === "linux" && hasSystemdRun();
  const cmd = useSystemd ? "systemd-run" : node;
  const args = useSystemd
    ? ["--user", "--scope", "--collect", `--unit=${scope}`, "--", node, tsx, worker, String(runId)]
    : [tsx, worker, String(runId)];
  const child = nodeSpawn(cmd, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
};

function hasSystemdRun(): boolean {
  try {
    require("node:child_process").execFileSync("systemd-run", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run __tests__/run-dispatch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/run-dispatch.ts __tests__/run-dispatch.test.ts
git commit -m "feat(runs): add dispatchRun with atomic claim + systemd-run spawn strategy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: `run-worker.ts` entry point

**Files:**
- Create: `scripts/run-worker.ts`
- Test: `__tests__/run-worker.test.ts`

**Interfaces:**
- Produces: `async function runWorkerMain(runId: number): Promise<void>` (exported for tests) plus a bottom-of-file `if (import.meta.url === ...)`-style guard that reads `process.argv[2]` and calls it, then `process.exit`.
- Behavior: load the run; select the worker by kind and invoke the existing (currently module-private) worker. This requires exporting thin re-entry wrappers from `lib/runs.ts`: `export function resumeDispatched(runId)` that routes to `kickoffFirstTurn` / `runReview` / `runExecute` / the append-resume path based on `run.goal` and whether `sdkSessionId` is set. Add these exports in this task.
- Consumes: `dotenv` config (mirror `scripts/pipe.ts` ordering: `config()` before importing `../db` / `../lib/*`).

- [ ] **Step 1: Export a re-entry router from `lib/runs.ts`**

Add near the other exports:

```ts
// lib/runs.ts — re-entry point for a detached worker process. Picks the right
// worker for an already-created (and claimed) run and drives one turn to
// completion. Mirrors the in-process launch branches in create()/append().
export async function driveDispatchedRun(runId: number): Promise<void> {
  const run = get(runId);
  if (!run) return;
  if (run.goal === "<review>") {
    await runReview(runId, run.prUrl!, null);
  } else if (run.goal === "<execute>") {
    await runExecute(runId, run.planId!, null);
  } else {
    // implement / chat worktree: resume if we have a session, else first turn.
    if (run.sdkSessionId) {
      // drain the resume generator to completion
      for await (const _ of append({ runId, role: "system", text: RESUME_SENTINEL })) { /* consume */ }
    } else {
      await kickoffFirstTurn(runId, run.taskId, null);
    }
  }
}
```

Define `const RESUME_SENTINEL = "<resume>"` if the append path needs a nonempty prompt; if `append` already supports a resume-without-new-message call, use that instead (check `append`'s `AppendInput` — if `text` is optional for resume, pass no text). Keep `runReview`/`runExecute`/`kickoffFirstTurn` private; only `driveDispatchedRun` is exported.

- [ ] **Step 2: Write the failing integration test**

```ts
// __tests__/run-worker.test.ts
import { describe, expect, it, vi } from "vitest";
import { create, get, listMessages, driveDispatchedRun } from "../lib/runs";
import * as backend from "../lib/agent-backend";

// Stub getBackend to a fake whose runTurn emits one assistant envelope then a
// result. If a shared fake backend already exists under __tests__/helpers,
// import that instead of hand-rolling one here.
describe("driveDispatchedRun", () => {
  it("runs a chat turn to a terminal/idle status and persists an agent message", async () => {
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake",
      async runTurn(args: any) {
        args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
        args.onEvent({ type: "result", is_error: false, result: "done", usage: {} });
        return { summary: "done", resumeToken: "sess-1", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
      },
    } as any);

    const run = create({ goal: "<chat>", defer: true });
    await driveDispatchedRun(run.id);

    expect(["idle", "completed"]).toContain(get(run.id)!.status);
    expect(listMessages(run.id).some((m) => m.role === "agent")).toBe(true);
    vi.restoreAllMocks();
  });
});
```

Match the fake `runTurn` return shape to `TurnOutcome` in `lib/agent-backend/types.ts` (read it and adjust field names if the fake fails to typecheck).

- [ ] **Step 3: Run test**

Run: `npx vitest run __tests__/run-worker.test.ts`
Expected: FAIL until `driveDispatchedRun` is exported (Step 1) and the fake matches `TurnOutcome`. Iterate the fake's shape against `lib/agent-backend/types.ts` until PASS.

- [ ] **Step 4: Write the CLI wrapper**

```ts
// scripts/run-worker.ts
#!/usr/bin/env node
import { config } from "dotenv";
config({ path: ".env.local" });

import { driveDispatchedRun } from "../lib/runs";

async function main() {
  const runId = parseInt(process.argv[2] ?? "", 10);
  if (!Number.isFinite(runId)) {
    console.error("[run-worker] usage: run-worker <runId>");
    process.exit(2);
  }
  try {
    await driveDispatchedRun(runId);
    process.exit(0);
  } catch (e) {
    console.error("[run-worker] fatal:", e instanceof Error ? e.stack : e);
    process.exit(1);
  }
}
void main();
```

- [ ] **Step 5: Smoke-test the entry point end to end**

Run: `TASK_ORCH_DB=$(mktemp -u).db npx tsx scripts/run-worker.ts 999999`
Expected: exits 0 quickly (missing run ⇒ no-op) with no throw. (A real run requires backend creds; the integration test in Step 2 is the behavioral gate.)

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck && npx vitest run __tests__/run-worker.test.ts`

```bash
git add scripts/run-worker.ts lib/runs.ts __tests__/run-worker.test.ts
git commit -m "feat(runs): add detached run-worker entry point + driveDispatchedRun router

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Route create/append through dispatch (flag-gated)

### Task 6: gate the in-process launches behind the flag

**Files:**
- Modify: `lib/runs.ts` — `create()` launch branches (~lines 355-375) and the `append()` resume launch.
- Test: `__tests__/dispatch-routing.test.ts`

**Interfaces:**
- Consumes: `dispatchRun`, `detachedRunsEnabled` from `lib/run-dispatch`.
- Behavior: when `detachedRunsEnabled()` is true, each place that today does `void kickoffFirstTurn(...)` / `void runReview(...)` / `void runExecute(...)` instead calls `dispatchRun(run.id)`. When false, unchanged. `append()`: when the flag is on and the call is a resume of an idle run *by a dispatch* (not the caller's own streaming POST), skip the in-process turn and `dispatchRun`. Keep the caller-facing `POST /messages` streaming path in-process even when the flag is on (that stream is the caller's own turn); only the secondary/kickoff launches detach. Document this split in a comment.

Avoid an import cycle: `lib/run-dispatch.ts` imports from `lib/runs.ts`. Import `dispatchRun` lazily inside the launch branch (`const { dispatchRun, detachedRunsEnabled } = await import("./run-dispatch")`) or via a function-scoped `require`, so module load order stays clean. Prefer a top-of-turn dynamic import in the (already async) branches.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/dispatch-routing.test.ts
import { describe, expect, it, vi, afterEach } from "vitest";
import * as dispatch from "../lib/run-dispatch";
import { create, get } from "../lib/runs";

afterEach(() => { delete process.env.TASK_ORCH_DETACHED_RUNS; vi.restoreAllMocks(); });

describe("create() routing under the flag", () => {
  it("dispatches instead of running in-process when the flag is on", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const spy = vi.spyOn(dispatch, "dispatchRun").mockReturnValue("spawned");
    create({ goal: "<execute>", planId: "P-x", defer: false } as any);
    await new Promise((r) => setTimeout(r, 20)); // allow the async launch branch to run
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT dispatch when the flag is off", async () => {
    const spy = vi.spyOn(dispatch, "dispatchRun").mockReturnValue("spawned");
    // defer:true so no real in-process worker starts
    create({ goal: "<execute>", planId: "P-y", defer: true } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });
});
```

The first test may need `planId` to reference a real plan row if `create()` validates it; if so, seed a plan via the repo helper first (check `create()`'s validation of `planId`). Adjust to a `<review>` run with a `prUrl` if `<execute>` validation is heavier.

- [ ] **Step 2: Run test**

Run: `npx vitest run __tests__/dispatch-routing.test.ts`
Expected: FAIL — `dispatchRun` not yet wired into `create()`.

- [ ] **Step 3: Wire the launch branches**

In each launch branch in `create()` and the `append` resume launch, wrap:

```ts
// example: plan-executor branch
if (!input.defer && goal === "<execute>" && input.planId) {
  void (async () => {
    const { detachedRunsEnabled, dispatchRun } = await import("./run-dispatch");
    if (detachedRunsEnabled()) dispatchRun(run.id);
    else await runExecute(run.id, input.planId!, input.initialPrompt ?? null);
  })();
}
```

Apply the same shape to the implement (`kickoffFirstTurn`) and review (`runReview`) branches. For `append`, gate only the non-caller resume launches as described in Interfaces.

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run __tests__/dispatch-routing.test.ts && npx vitest run`
Expected: PASS; no regressions (flag defaults off, so existing tests are unaffected).

- [ ] **Step 5: Commit**

```bash
git add lib/runs.ts __tests__/dispatch-routing.test.ts
git commit -m "feat(runs): route run launches through dispatchRun when TASK_ORCH_DETACHED_RUNS is set

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Cross-process cancel

### Task 7: DB-mediated cancel

**Files:**
- Modify: `lib/runs.ts` — `cancel()` sets `cancelRequested`; the turn loop polls it.
- Test: `__tests__/cross-process-cancel.test.ts`

**Interfaces:**
- Consumes: `cancelRequested` column.
- `cancel(id)`: when `detachedRunsEnabled()`, set `cancelRequested: 1` on the row (in addition to today's in-process abort, which is a no-op cross-process). Add `export function isCancelRequested(runId: number): boolean` reading the column fresh.
- Worker turn loop: the heartbeat interval already fires every `HEARTBEAT_INTERVAL_MS`. In the same interval callback (or a sibling interval at the same cadence) inside `runReview`/`runExecute`/the turn helper, check `isCancelRequested(runId)`; if true call the local `abort.abort()`. Because all three workers already thread an `AbortController` named `abort`, add the poll where each starts its heartbeat.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/cross-process-cancel.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, cancel, isCancelRequested } from "../lib/runs";

afterEach(() => { delete process.env.TASK_ORCH_DETACHED_RUNS; });

describe("DB-mediated cancel", () => {
  it("sets cancel_requested when the flag is on", () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const run = create({ goal: "<implement>", defer: true });
    db.update(agentSessions).set({ status: "running", heartbeatAt: new Date() }).where(eq(agentSessions.id, run.id)).run();
    cancel(run.id);
    expect(isCancelRequested(run.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run __tests__/cross-process-cancel.test.ts`
Expected: FAIL — `isCancelRequested` undefined / column not set by `cancel`.

- [ ] **Step 3: Implement**

Add to `lib/runs.ts`:

```ts
export function isCancelRequested(runId: number): boolean {
  const row = db.select({ c: agentSessions.cancelRequested }).from(agentSessions)
    .where(eq(agentSessions.id, runId)).get();
  return row?.c === 1;
}
```

In `cancel(id)`, before/after the existing in-process abort, add:

```ts
  // Cross-process: a detached worker can't see our AbortController, so signal
  // via the DB. The worker polls isCancelRequested() at heartbeat cadence.
  db.update(agentSessions).set({ cancelRequested: 1 }).where(eq(agentSessions.id, id)).run();
```

In `runReview`, `runExecute`, and the shared turn driver, where `const heartbeat = startHeartbeat(runId)` is set up, replace with a combined interval that also polls cancel:

```ts
  const heartbeat = setInterval(() => {
    touchHeartbeat(runId);
    if (isCancelRequested(runId) && !abort.signal.aborted) abort.abort();
  }, HEARTBEAT_INTERVAL_MS);
```

(`touchHeartbeat` and `HEARTBEAT_INTERVAL_MS` already exist; keep `startHeartbeat` for any callers that don't have an `abort` in scope.)

- [ ] **Step 4: Run test + suite**

Run: `npx vitest run __tests__/cross-process-cancel.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runs.ts __tests__/cross-process-cancel.test.ts
git commit -m "feat(runs): DB-mediated cancel for detached workers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Reconcile re-dispatch + systemd wiring + verification

### Task 8: re-dispatch resumable orphans on boot

**Files:**
- Modify: `lib/runs.ts` — `reconcileOrphanedRuns()`.
- Test: extend `__tests__/reconcile-orphaned-runs.test.ts`.

**Interfaces:**
- Behavior: when `detachedRunsEnabled()`, a stale-heartbeat orphan that is resumable (`isResumableWorktreeRun(status, cwdStrategy)` true AND `sdkSessionId` set AND `worktreePath` exists on disk) is **re-dispatched** (clear `workerScope` to null first so `dispatchRun` can re-claim, then `dispatchRun(id)`) instead of being marked `failed`. Non-resumable orphans and all orphans when the flag is off keep today's behavior (`<chat>` → idle, else failed). Return count reaped includes re-dispatched.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/reconcile-orphaned-runs.test.ts`:

```ts
import { existsSync } from "node:fs";
import * as dispatch from "../lib/run-dispatch";
// ...
it("re-dispatches a stale resumable worktree run when the flag is on", () => {
  process.env.TASK_ORCH_DETACHED_RUNS = "1";
  const spy = vi.spyOn(dispatch, "dispatchRun").mockReturnValue("spawned");
  const run = create({ goal: "<implement>", defer: true });
  // Make it look resumable: worktree run, has a session, worktree exists.
  db.update(agentSessions)
    .set({ status: "running", heartbeatAt: STALE, sdkSessionId: "sess-1", worktreePath: process.cwd() })
    .where(eq(agentSessions.id, run.id)).run();

  reconcileOrphanedRuns();

  expect(spy).toHaveBeenCalledWith(run.id);
  expect(get(run.id)?.status).not.toBe("failed");
  delete process.env.TASK_ORCH_DETACHED_RUNS;
  vi.restoreAllMocks();
});
```

Add `import { vi } from "vitest"` if absent. Use `process.cwd()` as a guaranteed-existing `worktreePath` so the `existsSync` guard passes.

- [ ] **Step 2: Run test**

Run: `npx vitest run __tests__/reconcile-orphaned-runs.test.ts`
Expected: FAIL — orphan is marked `failed`, `dispatchRun` not called.

- [ ] **Step 3: Implement**

In `reconcileOrphanedRuns()`, inside the `if (!isLeaseLive(row))` block, before the existing chat/else branches:

```ts
    if (detachedRunsEnabled() && row.goal !== "<chat>"
        && isResumableWorktreeRun(row.status, row.cwdStrategy)
        && row.sdkSessionId && row.worktreePath && existsSync(row.worktreePath)) {
      // Worker died (host reboot/OOM) but the work is resumable — hand it to a
      // fresh detached worker instead of failing it. Clear the claim first.
      db.update(agentSessions).set({ workerScope: null }).where(eq(agentSessions.id, row.id)).run();
      const { dispatchRun } = require("./run-dispatch") as typeof import("./run-dispatch");
      dispatchRun(row.id);
      reaped++;
      continue;
    }
```

Add `import { existsSync } from "node:fs"` and `import { detachedRunsEnabled } from "./run-dispatch"` at the top (or a function-scoped require to avoid a cycle, matching Task 6's approach).

- [ ] **Step 4: Run test + suite**

Run: `npx vitest run __tests__/reconcile-orphaned-runs.test.ts && npx vitest run`
Expected: PASS; existing reconcile cases still pass (flag off path unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/runs.ts __tests__/reconcile-orphaned-runs.test.ts
git commit -m "feat(runs): re-dispatch resumable orphans on boot instead of failing them

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 9: systemd wiring, boot reconcile for the web process, docs, acceptance

**Files:**
- Modify: `instrumentation.ts` — call `reconcileOrphanedRuns()` on the Next server's boot (it currently doesn't).
- Modify: `deploy.sh` and/or the web systemd unit — ensure `--user` lingering is enabled and document the flag.
- Modify: `README.md` (Production deployment section) + `docs/superpowers/specs/2026-07-02-detached-run-workers-design.md` status.
- Test: manual acceptance.

**Interfaces:**
- `instrumentation.register()` gains a guarded `reconcileOrphanedRuns()` call for `NEXT_RUNTIME === "nodejs"`. Import it the same dynamic way the file already imports `worktree-gc` (webpackIgnore) to avoid the prod-bundle module-resolution issue documented in that file.

- [ ] **Step 1: Add boot reconcile to the Next server**

In `instrumentation.ts` `register()`, after the runtime guard:

```ts
  const runsMod = (await import(/* webpackIgnore: true */ "./lib/runs")) as {
    reconcileOrphanedRuns: () => number;
  };
  runsMod.reconcileOrphanedRuns();
```

Place it before the existing `TASK_ORCH_WORKTREE_GC` gate so it always runs (it's cheap and idempotent). Verify `next build` still succeeds (Step 4).

- [ ] **Step 2: Enable lingering + document (deploy)**

In `deploy.sh`, add an idempotent step near the systemd setup:

```bash
# Detached run workers (M1) spawn transient `systemd-run --user --scope` units;
# these must survive the deploying login session, so enable lingering.
loginctl enable-linger "$SERVICE_USER" 2>/dev/null || true
```

Set `SERVICE_USER` to the account the web unit runs as (grep `deploy.sh` for the existing user/service variable and reuse it). If `deploy.sh` writes the unit file, add `Environment=TASK_ORCH_DETACHED_RUNS=1` to the web unit's `[Service]` section (leave it commented/off until Step 5 verification passes).

- [ ] **Step 3: Document in README**

Under "Production deployment", add a short subsection: what `TASK_ORCH_DETACHED_RUNS` does, that it requires `systemd-run --user` + lingering, and that runs then survive `systemctl restart`. Update the design doc's Status line to `Implemented`.

- [ ] **Step 4: Build + full suite**

Run: `npm run build && npm run typecheck && npx vitest run`
Expected: build succeeds (instrumentation import resolves), all tests pass.

- [ ] **Step 5: Manual acceptance (the whole point)**

On a machine with the flag on:
1. Start a long implement/execute run; confirm it reaches `running` and streams to the run view.
2. `systemctl --user restart <web-unit>` mid-turn.
3. Confirm: the run's `systemd-run` scope is still alive (`systemctl --user list-units 'run-*'`), the run keeps progressing (heartbeat advances, new `agent_messages` rows land), and the reopened run view resumes streaming with no gap.
4. Confirm a normal completion still writes a terminal status and the scope is GC'd (`--collect`).
5. Cancel a detached run from the UI; confirm `cancel_requested` propagates and the worker stops within ~one heartbeat interval.

- [ ] **Step 6: Commit**

```bash
git add instrumentation.ts deploy.sh README.md docs/superpowers/specs/2026-07-02-detached-run-workers-design.md
git commit -m "feat(deploy): boot reconcile in web process + systemd-run lingering for detached runs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes (coverage map)

- Spec §Architecture/C1 → Tasks 4, 5, 6. §Detach M1 → Task 4 `defaultSpawn` + Task 9 lingering.
- Spec §Streaming (a) → Tasks 1, 2.
- Spec §Cross-process control → Task 7.
- Spec §Boot/reconcile → Tasks 8, 9 (web boot reconcile).
- Spec §Error handling → claim idempotency (Task 4), spawn fallback ladder (Task 4 `defaultSpawn`), SSE terminal/backoff (Task 2), no queue (explicitly out of scope).
- Spec §Testing → each task's tests + Task 9 acceptance.
- Spec §Rollout phases 1-5 → Phases 1-5 here. §Schema → Task 3.
- Spec §Out of scope (queue, unified stream table, token-level streaming, pi migration) → not implemented, by design.
