// __tests__/nested-dispatch.test.ts
//
// docs/nested-machine-dispatch.md Decisions 1 + 5 + 6: a run spawned INSIDE a
// worker under the "isolate" nested-dispatch policy must NOT be dispatched from
// the worker (which holds no Fly credentials). create()'s launch branches park
// it at status 'pending' — the server's pending pump then gives it its own Fly
// Machine — persist its initialPrompt, and emit a runner_deferred event. Every
// other combination (worker+inline, server) keeps today's dispatchRun behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentEvents, agentMessages, agentSessions } from "../db/schema";
import * as dispatch from "../lib/run-dispatch";
import { nestedDispatchMode } from "../lib/run-dispatch";
import { buildFlyWorkerEnv } from "../lib/runner/fly";
import { create, get } from "../lib/runs";

const KNOBS = [
  "TASK_ORCH_NESTED_DISPATCH",
  "TASK_ORCH_RUNNER",
  "TASK_ORCH_INSIDE_WORKER",
  "TASK_ORCH_DETACHED_RUNS",
];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  vi.restoreAllMocks();
});

// Build a valid detached <review> run (needs a prUrl; worktree_at_pr triggers
// the review launch branch). Returns the created run.
async function createReview(opts: { initialPrompt?: string; parentRunId?: number } = {}) {
  return create({
    goal: "<review>",
    cwdStrategy: "worktree_at_pr",
    prUrl: "https://github.com/o/r/pull/1",
    initialPrompt: opts.initialPrompt ?? null,
    parentRunId: opts.parentRunId ?? null,
  } as any);
}

// The launch branches are fire-and-forget (`void (async…)`), so poll for the
// side effect rather than racing a fixed sleep.
async function runnerDeferredEvents(runId: number) {
  return db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "runner_deferred")));
}

describe("nestedDispatchMode()", () => {
  it("honors an explicit env value (case-insensitive), ignoring the provider", () => {
    process.env.TASK_ORCH_RUNNER = "fly"; // default would be isolate
    process.env.TASK_ORCH_NESTED_DISPATCH = "inline";
    expect(nestedDispatchMode()).toBe("inline");
    process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
    expect(nestedDispatchMode()).toBe("isolate");
    process.env.TASK_ORCH_NESTED_DISPATCH = "ISOLATE";
    expect(nestedDispatchMode()).toBe("isolate");
  });

  it("falls through to the provider default on a garbage env value", () => {
    process.env.TASK_ORCH_NESTED_DISPATCH = "banana";
    // no TASK_ORCH_RUNNER → local → inline
    expect(nestedDispatchMode()).toBe("inline");
    process.env.TASK_ORCH_RUNNER = "fly";
    expect(nestedDispatchMode()).toBe("isolate");
  });

  it("defaults to isolate on Fly and inline otherwise when unset", () => {
    expect(nestedDispatchMode()).toBe("inline"); // no runner
    process.env.TASK_ORCH_RUNNER = "fly";
    expect(nestedDispatchMode()).toBe("isolate");
  });
});

describe("create() launch branches: nested-dispatch isolate", () => {
  it("worker + isolate: parks 'pending', persists the prompt, emits runner_deferred, no worker claim", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
    // The choke point moved into dispatchRun (FIX A): the launch branch DOES call
    // the real dispatchRun, which — under worker+isolate — parks the row rather
    // than spawning. So we assert observable OUTCOMES (status/claim/event/prompt),
    // not that dispatchRun went uncalled. Let the real dispatchRun run.
    const parent = await create({ goal: "<implement>", defer: true });
    const run = await createReview({ initialPrompt: "please review carefully", parentRunId: parent.id });

    // Wait for the fire-and-forget launch branch to record the deferral.
    await expect.poll(async () => (await runnerDeferredEvents(run.id)).length).toBe(1);

    const parked = (await get(run.id))!;
    expect(parked.status).toBe("pending"); // still queued for the server's pump
    expect(parked.workerScope).toBeNull(); // never claimed a worker inside the worker

    const events = await runnerDeferredEvents(run.id);
    expect(events.length).toBe(1); // exactly one
    expect(JSON.parse(events[0].payload as string)).toEqual({
      parentRunId: parent.id,
      reason: "nested_isolate",
    });

    const msgs = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.runId, run.id), eq(agentMessages.role, "user")));
    expect(msgs.length).toBe(1);
    expect(JSON.stringify(msgs[0].content)).toContain("please review carefully");
  });

  it("dispatchRun itself parks under worker+isolate: returns 'deferred', never spawns, leaves 'pending'", async () => {
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
    const run = await create({ goal: "<implement>", defer: true });
    // Put it on the real pump surface (a queued row).
    await db.update(agentSessions).set({ status: "pending" }).where(eq(agentSessions.id, run.id));

    const spawn = vi.fn(() => 1);
    const result = await dispatch.dispatchRun(run.id, { spawn });

    expect(result).toBe("deferred");
    expect(spawn).not.toHaveBeenCalled();
    const row = (await get(run.id))!;
    expect(row.status).toBe("pending");
    expect(row.workerScope).toBeNull();
  });

  it("dispatchRun under worker+isolate does NOT resurrect a 'cancelled' run", async () => {
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions).set({ status: "cancelled" }).where(eq(agentSessions.id, run.id));

    const spawn = vi.fn(() => 1);
    const result = await dispatch.dispatchRun(run.id, { spawn });

    expect(result).toBe("deferred");
    expect(spawn).not.toHaveBeenCalled();
    const row = (await get(run.id))!;
    // The park's conditional UPDATE excludes 'cancelled'/'closed' — the terminal
    // decision stands; no flip back to 'pending'.
    expect(row.status).toBe("cancelled");
  });

  it("worker + inline: dispatches (no parking, no runner_deferred)", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    process.env.TASK_ORCH_NESTED_DISPATCH = "inline";
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");

    const run = await createReview({ initialPrompt: "inline review" });
    await expect.poll(() => spy.mock.calls.length).toBe(1);

    expect(spy).toHaveBeenCalledWith(run.id);
    expect((await runnerDeferredEvents(run.id)).length).toBe(0);
  });

  it("server + isolate: still dispatches — isolate only changes worker behavior", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    // NO TASK_ORCH_INSIDE_WORKER → this is the server.
    process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");

    const run = await createReview({ initialPrompt: "server review" });
    await expect.poll(() => spy.mock.calls.length).toBe(1);

    expect(spy).toHaveBeenCalledWith(run.id);
    expect((await runnerDeferredEvents(run.id)).length).toBe(0);
  });
});

describe("buildFlyWorkerEnv nested-dispatch passthrough", () => {
  it("passes the resolved policy (isolate on Fly by default)", () => {
    process.env.TASK_ORCH_RUNNER = "fly";
    expect(buildFlyWorkerEnv(42).TASK_ORCH_NESTED_DISPATCH).toBe("isolate");
  });

  it("passes an explicit inline override (rollback)", () => {
    process.env.TASK_ORCH_RUNNER = "fly";
    process.env.TASK_ORCH_NESTED_DISPATCH = "inline";
    expect(buildFlyWorkerEnv(42).TASK_ORCH_NESTED_DISPATCH).toBe("inline");
  });
});
