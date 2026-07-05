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
  it("worker + isolate: parks 'pending', persists the prompt, emits runner_deferred, does NOT dispatch", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    process.env.TASK_ORCH_NESTED_DISPATCH = "isolate";
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");

    const parent = await create({ goal: "<implement>", defer: true });
    const run = await createReview({ initialPrompt: "please review carefully", parentRunId: parent.id });

    // Wait for the fire-and-forget launch branch to record the deferral.
    await expect.poll(async () => (await runnerDeferredEvents(run.id)).length).toBe(1);

    expect(spy).not.toHaveBeenCalled();
    expect((await get(run.id))?.status).toBe("pending");

    const events = await runnerDeferredEvents(run.id);
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

describe("buildFlyWorkerEnv REPO_CACHE_DIR", () => {
  const REPO_CACHE_KNOB = "TASK_ORCH_REPO_CACHE_DIR";
  afterEach(() => {
    delete process.env[REPO_CACHE_KNOB];
  });

  it("defaults to the image-baked cache dir when TASK_ORCH_REPO_CACHE_DIR is unset", () => {
    delete process.env[REPO_CACHE_KNOB];
    expect(buildFlyWorkerEnv(42).REPO_CACHE_DIR).toBe("/opt/repo-cache");
  });

  it("honors a TASK_ORCH_REPO_CACHE_DIR override", () => {
    process.env[REPO_CACHE_KNOB] = "/custom/cache";
    expect(buildFlyWorkerEnv(42).REPO_CACHE_DIR).toBe("/custom/cache");
  });
});
