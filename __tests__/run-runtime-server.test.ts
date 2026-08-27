// __tests__/run-runtime-server.test.ts
//
// Milestone 2 of the Discord-persona plan: execution placement is a per-run
// property again (`agent_runs.runtime`), not the global remoteRunnerEnabled()
// switch. Pinned here:
//   • runs.create() honors `runtime` (default 'worker') and guards it — no
//     shell/fs/repo-write tools profile, no claude backend, no checkout.
//   • sendMessageToRun takes the in-process append path for a server-runtime
//     run EVEN under a remote-runner deployment; a worker-runtime run keeps
//     dispatching exactly as before.
//   • runOneTurn drives a server-runtime pi run through the postgres context
//     mode (lib/agent-backend/postgres-turn.ts), not an SDK session file.
//   • the pending-run pump / dispatch front door never spawn a worker for a
//     server-runtime row; a wake is handed to the in-process turn driver.

import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentMessages, agentSessions } from "../db/schema";
import * as backend from "../lib/agent-backend";
import * as dispatch from "../lib/run-dispatch";
import { __resetDemotionWarnings, isServerRuntimeRun } from "../lib/run-runtime";
import * as inbox from "../lib/inbox";
import { emitInboxEvent, hasPendingInboxEvents } from "../lib/inbox";
import * as repo from "../lib/repo";
import {
  append,
  create,
  get,
  listPendingRunIds,
  reconcileOrphanedRuns,
  sendMessageToRun,
  wakeServerRun,
} from "../lib/runs";

const ENV_KEYS = [
  "TASK_ORCH_DETACHED_RUNS",
  "TASK_ORCH_WORKER_IMAGE",
  "TASK_ORCH_RUNNER",
  "TASK_ORCH_INSIDE_WORKER",
  "TASK_ORCH_AGENT_BACKEND",
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

/** A deployment where every worker-runtime turn MUST go out of process. */
function remoteRunnerDeployment() {
  process.env.TASK_ORCH_DETACHED_RUNS = "1";
  process.env.TASK_ORCH_WORKER_IMAGE = "task-orch-worker:test";
  expect(dispatch.remoteRunnerEnabled()).toBe(true);
}

/** Stubbed agent backend: records the context mode it was handed and emits one
 *  assistant message so the turn persists something observable. */
function stubBackend() {
  const seen: Array<{ contextKind: string; prompt: string }> = [];
  vi.spyOn(backend, "getBackend").mockResolvedValue({
    id: "pi",
    async runTurn(args: any) {
      seen.push({ contextKind: args.contextSource?.kind, prompt: args.prompt });
      args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "in-process reply" }] } });
      args.onEvent({ type: "result", is_error: false, result: "in-process reply", usage: {} });
      return {
        summary: "in-process reply",
        resumeToken: null,
        turns: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalCostUsd: 0,
      };
    },
  } as any);
  return seen;
}

async function agentTexts(runId: number): Promise<string[]> {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.runId, runId));
  return rows.filter((r) => r.role === "agent").map((r) => r.content);
}

const SERVER_CHAT = {
  goal: "<chat>" as const,
  runtime: "server" as const,
  cwdStrategy: "none" as const,
  toolsProfile: "orchestrator,spawn",
  backend: "pi" as const,
};

describe("runs.create() placement", () => {
  it("defaults to worker runtime and stores an explicit server runtime", async () => {
    const worker = await create({ goal: "<chat>", defer: true });
    expect(worker.runtime).toBe("worker");

    const server = await create(SERVER_CHAT);
    expect(server.runtime).toBe("server");
    expect((await get(server.id))!.runtime).toBe("server");
  });

  it("rejects a server-runtime run whose tools profile can reach a shell/fs/repo write", async () => {
    await expect(
      create({ ...SERVER_CHAT, toolsProfile: "orchestrator,repo_write" })
    ).rejects.toThrow(/repo_write/);
    // repo_read is unsafe too: it spawns git and reads the server's own checkout.
    await expect(
      create({ ...SERVER_CHAT, toolsProfile: "orchestrator,repo_read" })
    ).rejects.toThrow(/repo_read/);
    // gh_pr can merge/approve with the server's GitHub credentials.
    await expect(
      create({ ...SERVER_CHAT, toolsProfile: "orchestrator,gh_pr" })
    ).rejects.toThrow(/gh_pr/);
    // An unknown profile can't be vouched for either.
    await expect(
      create({ ...SERVER_CHAT, toolsProfile: "orchestrator,not_a_profile" })
    ).rejects.toThrow(/not_a_profile/);
  });

  it("accepts the tool-mediated orchestration profiles", async () => {
    const run = await create({
      ...SERVER_CHAT,
      toolsProfile: "orchestrator,spawn,planning,gh_pr_ro,gh_ci",
    });
    expect(run.runtime).toBe("server");
  });

  it("leaves worker-runtime runs free to use repo_write", async () => {
    const run = await create({ goal: "<chat>", toolsProfile: "orchestrator,repo_write", defer: true });
    expect(run.runtime).toBe("worker");
  });

  it("rejects a server-runtime run on the claude backend (postgres mode is pi-only)", async () => {
    await expect(create({ ...SERVER_CHAT, backend: "claude" })).rejects.toThrow(/pi/);
  });

  it("rejects a server-runtime run whose goal would strand it at 'pending'", async () => {
    // No worker tier to dispatch a kickoff to, and 'pending' on a server row is
    // watched by nobody: not listPendingRunIds (worker-only dispatch queue, so
    // no pump retry and no max-defer failer), not the parked wake sweep, not
    // reconcile (no lease). Reject at create time instead of inserting a ghost.
    await expect(create({ ...SERVER_CHAT, goal: "<implement>" })).rejects.toThrow(/pending/);
    // defer:true is the documented way out — the row lands 'idle' and waits for
    // its first message.
    const deferred = await create({ ...SERVER_CHAT, goal: "<implement>", defer: true });
    expect(deferred.status).toBe("idle");
    expect(deferred.runtime).toBe("server");
  });

  it("rejects a server-runtime plan executor too — it does NOT self-drive when detached", async () => {
    // There used to be a carve-out here for goal '<execute>' + planId, on the
    // theory that create()'s executor branch takes the turn itself. It only does
    // so in the NON-detached branch: with TASK_ORCH_DETACHED_RUNS on (forced on
    // fly/box) the same branch goes launchDetached → dispatchRun → wakeServerRun,
    // which finds no pending inbox events on a fresh run and no-ops — leaving a
    // true-server row at 'pending' outside every belt. Same 400 as any other
    // pending-producing goal now.
    const plan = await repo.createPlan({ title: "Server Executor", date: "2026-07-31" });
    await expect(
      create({ ...SERVER_CHAT, goal: "<execute>", planId: plan.id })
    ).rejects.toThrow(/pending/);

    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    await expect(
      create({ ...SERVER_CHAT, goal: "<execute>", planId: plan.id })
    ).rejects.toThrow(/pending/);

    // No ghost row was inserted for either attempt.
    expect(
      await db.select().from(agentSessions).where(eq(agentSessions.planId, plan.id))
    ).toHaveLength(0);

    // defer:true remains the way to make one: it lands 'idle' and waits for a
    // message, which the server tier can actually drive.
    const deferred = await create({ ...SERVER_CHAT, goal: "<execute>", planId: plan.id, defer: true });
    expect(deferred.status).toBe("idle");
    expect(deferred.runtime).toBe("server");
  });

  it("rejects a server-runtime run that would need a checkout", async () => {
    await expect(
      create({ ...SERVER_CHAT, cwdStrategy: "repo" })
    ).rejects.toThrow(/cwdStrategy/);
  });
});

describe("sendMessageToRun placement branch", () => {
  it("runs a server-runtime turn in-process even with a remote runner configured", async () => {
    remoteRunnerDeployment();
    const seen = stubBackend();
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");

    const run = await create(SERVER_CHAT);
    const abort = new AbortController();
    const events: any[] = [];
    for await (const ev of sendMessageToRun({ runId: run.id, role: "user", text: "hi", abort })) {
      events.push(ev);
    }

    expect(spy).not.toHaveBeenCalled();
    // The in-process append() path yields the persisted user row itself; the
    // relay path (worker runtime) never does.
    expect(events.some((e) => e.type === "user_message")).toBe(true);
    expect(await agentTexts(run.id)).toHaveLength(1);
    // Server runtime + pi ⇒ the conversation is rebuilt from agent_messages.
    expect(seen).toHaveLength(1);
    expect(seen[0].contextKind).toBe("postgres");
    expect((await get(run.id))!.status).toBe("idle");
  });

  it("still dispatches a worker-runtime chat run (unchanged behavior)", async () => {
    remoteRunnerDeployment();
    stubBackend();
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");

    const run = await create({ goal: "<chat>", defer: true });
    const abort = new AbortController();
    const gen = sendMessageToRun({ runId: run.id, role: "user", text: "hi", abort });
    await gen.next(); // persist + dispatch happen before the first relayed frame
    abort.abort();
    await gen.return(undefined as never).catch(() => {});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await agentTexts(run.id)).toHaveLength(0); // the (stubbed) worker owns the turn
  });
});

describe("dispatch never gives a server-runtime run a worker", () => {
  it("routes a dispatch/wake of a server-runtime run to the in-process driver", async () => {
    remoteRunnerDeployment();
    const seen = stubBackend();
    const spawn = vi.fn().mockResolvedValue(1234);

    const run = await create(SERVER_CHAT);
    // A wake only means something when there is something to wake FOR: the turn
    // driver no-ops on an empty inbox (see the double-wake test below), so give
    // the run a pending event first.
    await emitInboxEvent({
      targetRunId: run.id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(run.id),
      payload: { summary: "child finished" },
    });
    const result = await dispatch.dispatchRun(run.id, { spawn });

    expect(result).toBe("server-runtime");
    expect(spawn).not.toHaveBeenCalled();
    // The wake is kicked off in the background so the pump isn't blocked on a
    // model turn; it still lands an in-process turn.
    await vi.waitFor(async () => expect(await agentTexts(run.id)).toHaveLength(1));
    expect(seen).toHaveLength(1);
    // The wake runs in the background: the message persists mid-turn but the
    // server-turn claim (worker_scope 'server-<nonce>') is only released in a
    // finally after the turn fully lands — poll instead of reading once.
    await vi.waitFor(async () => {
      const after = await get(run.id);
      expect(after!.workerScope).toBeNull();
      expect(after!.status).toBe("idle");
    });
  });

  it("still spawns a worker for a worker-runtime run", async () => {
    remoteRunnerDeployment();
    const spawn = vi.fn().mockResolvedValue(4321);

    const run = await create({ goal: "<chat>", defer: true });
    const result = await dispatch.dispatchRun(run.id, { spawn });

    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("gives a PARKED server run its inbox wake in-process (no worker spawn)", async () => {
    remoteRunnerDeployment();
    const seen = stubBackend();

    const run = await create(SERVER_CHAT);
    await db.update(agentSessions).set({ status: "parked" }).where(eq(agentSessions.id, run.id));

    await emitInboxEvent({
      targetRunId: run.id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(run.id),
      payload: { summary: "child finished" },
    });

    // The emit-time wake calls dispatchRun, which routes a server-runtime row to
    // the in-process driver instead of spawning.
    await vi.waitFor(async () => expect(await agentTexts(run.id)).toHaveLength(1));
    expect(seen[0].contextKind).toBe("postgres");
    // The digest of the event reached the model as prompt text.
    expect(seen[0].prompt).toMatch(/child\.result/);
    // Background wake: the claim release lands after the turn completes — poll.
    await vi.waitFor(async () => expect((await get(run.id))!.workerScope).toBeNull());
  });

  it("keeps server-runtime rows out of the pending-run pump queue", async () => {
    const server = await create(SERVER_CHAT);
    const worker = await create({ goal: "<chat>", defer: true });
    // Force both into the dispatch queue's status.
    await db.update(agentSessions).set({ status: "pending" }).where(eq(agentSessions.id, server.id));
    await db.update(agentSessions).set({ status: "pending" }).where(eq(agentSessions.id, worker.id));

    const pending = await listPendingRunIds();
    expect(pending).toContain(worker.id);
    expect(pending).not.toContain(server.id);
  });
});

// A row exactly as the retired lightweight tier left it: runtime='server' with
// the schema's default tools profile. runs.create() would refuse to make one
// today, so write the columns directly — which is the point: the guardrail is
// create-time only, and these rows already exist.
async function legacyUnsafeServerRun(): Promise<number> {
  const run = await create({ goal: "<chat>", defer: true, backend: "pi" });
  await db
    .update(agentSessions)
    .set({ runtime: "server", toolsProfile: "orchestrator,repo_write", cwdStrategy: "none" })
    .where(eq(agentSessions.id, run.id));
  return run.id;
}

describe("legacy server-runtime rows with an unsafe tools profile", () => {
  beforeEach(() => {
    __resetDemotionWarnings();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("is demoted to worker placement by the shared predicate", async () => {
    const id = await legacyUnsafeServerRun();
    const row = (await get(id))!;
    expect(row.runtime).toBe("server");
    // Placement AND tool surface have to agree; repo_write mounts git/readFile
    // against the orchestrator's own checkout.
    expect(isServerRuntimeRun(row)).toBe(false);
    expect(isServerRuntimeRun({ ...row, toolsProfile: "orchestrator,spawn" })).toBe(true);
  });

  it("DISPATCHES it remotely instead of forcing an in-process turn", async () => {
    remoteRunnerDeployment();
    stubBackend();
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");

    const id = await legacyUnsafeServerRun();
    const abort = new AbortController();
    const gen = sendMessageToRun({ runId: id, role: "user", text: "hi", abort });
    await gen.next();
    abort.abort();
    await gen.return(undefined as never).catch(() => {});

    // Pre-M2 behavior restored: a container owns this turn, not this process.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await agentTexts(id)).toHaveLength(0);
  });

  it("takes the SANDBOXED sdk-session path (not postgres mode) when driven in-process", async () => {
    // No remote runner: the legacy row falls back to the in-process append path
    // exactly like any worker row on a single-process dev server. It must NOT
    // land in postgres mode, which deliberately skips sandbox + env-scrub.
    const seen = stubBackend();
    const id = await legacyUnsafeServerRun();
    const abort = new AbortController();
    for await (const ev of sendMessageToRun({ runId: id, role: "user", text: "hi", abort })) void ev;

    expect(seen).toHaveLength(1);
    expect(seen[0].contextKind).not.toBe("postgres");
  });

  it("gets its worker belts back: the pending pump queue and the container sweep", async () => {
    const id = await legacyUnsafeServerRun();
    await db.update(agentSessions).set({ status: "pending" }).where(eq(agentSessions.id, id));
    // A true server row is excluded from the dispatch queue; a demoted one is not,
    // so it keeps both the pump retry and the max-defer failer.
    expect(await listPendingRunIds()).toContain(id);
  });

  it("is never woken in-process by the dispatch front door", async () => {
    remoteRunnerDeployment();
    stubBackend();
    const spawn = vi.fn().mockResolvedValue(1234);
    const id = await legacyUnsafeServerRun();
    await emitInboxEvent({
      targetRunId: id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(id),
      payload: { summary: "child finished" },
    });

    const result = await dispatch.dispatchRun(id, { spawn });
    expect(result).not.toBe("server-runtime");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("wakeServerRun is single-owner and event-driven", () => {
  it("no-ops a second wake once the first turn claimed the events", async () => {
    const seen = stubBackend();
    // Left at 'idle': emitInboxEvent's own emit-time wake only fires for 'parked'
    // rows, so the wakes below are the only drivers and the sequence is exact.
    const run = await create(SERVER_CHAT);
    await emitInboxEvent({
      targetRunId: run.id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(run.id),
      payload: { summary: "child finished" },
    });

    // First wake drives a turn, whose digest claim consumes the event.
    await wakeServerRun(run.id);
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toMatch(/child\.result/);
    expect(await hasPendingInboxEvents(run.id)).toBe(false);

    // Second wake — the ≤15s pump sweep arriving after the emit-time wake, or
    // vice versa. Nothing is pending any more, so it must NOT burn a model turn
    // on the bare wake prompt with an empty digest.
    await wakeServerRun(run.id);
    await wakeServerRun(run.id);
    expect(seen).toHaveLength(1);
    expect(await agentTexts(run.id)).toHaveLength(1);
    expect((await get(run.id))!.workerScope).toBeNull();
  });

  it("no-ops entirely when the run has no pending events at all", async () => {
    const seen = stubBackend();
    const run = await create(SERVER_CHAT);
    await wakeServerRun(run.id);
    expect(seen).toHaveLength(0);
    // The claim was never taken, so nothing was left half-held.
    const after = await get(run.id);
    expect(after!.workerScope).toBeNull();
    expect(after!.status).toBe("idle");
  });

  it("refuses to drive a turn while another process holds the run's claim", async () => {
    // The deterministic half of finding 2a: another process (a pipe user turn or
    // a sibling wake) already won the claim — worker_scope stamped, heartbeat
    // fresh — but the row's STATUS is still 'idle', so there is no lease and
    // the pre-CAS gates all pass. Only consulting the claim keeps this wake from
    // driving a second concurrent postgres turn into the same agent_messages.
    const seen = stubBackend();
    const run = await create(SERVER_CHAT);
    await emitInboxEvent({
      targetRunId: run.id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(run.id),
      payload: { summary: "child finished" },
    });
    await db
      .update(agentSessions)
      .set({ workerScope: "server-someone-else"})
      .where(eq(agentSessions.id, run.id));

    await wakeServerRun(run.id);

    expect(seen).toHaveLength(0);
    expect(await agentTexts(run.id)).toHaveLength(0);
    // The other owner's claim is untouched, and the events stay pending for it.
    const after = await get(run.id);
    expect(after!.workerScope).toBe("server-someone-else");
    expect(await hasPendingInboxEvents(run.id)).toBe(true);
  });

  it("releases the claim without a turn when the events go away after the pre-check", async () => {
    // Residual 3: the pending-events check used to run ONLY before the claim, so
    // a driver that claimed the digest in the window between that snapshot and
    // our CAS left this wake to burn a whole model turn on the bare wake prompt
    // with nothing attached. Simulate exactly that window: pending on the
    // pre-check, empty by the time we hold the claim.
    const seen = stubBackend();
    const run = await create(SERVER_CHAT);
    await emitInboxEvent({
      targetRunId: run.id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(run.id),
      payload: { summary: "child finished" },
    });

    let calls = 0;
    const spy = vi
      .spyOn(inbox, "hasPendingInboxEvents")
      .mockImplementation(async () => ++calls === 1);

    await wakeServerRun(run.id);
    spy.mockRestore();

    // Both gates ran (pre-check + post-claim re-check) and no turn was taken.
    expect(calls).toBe(2);
    expect(seen).toHaveLength(0);
    expect(await agentTexts(run.id)).toHaveLength(0);
    // The claim was released AND its 'preparing' stamp rolled back — the row is
    // exactly as we found it, so the real event is still there for its real owner.
    const after = await get(run.id);
    expect(after!.workerScope).toBeNull();
    expect(after!.status).toBe("idle");
    expect(await hasPendingInboxEvents(run.id)).toBe(true);
  });

  it("lets exactly ONE of two concurrent wakes drive a turn (server-turn CAS)", async () => {
    // Both wakes pass the isLive/isLeaseLive snapshot before either commits a
    // status — the race finding 2a describes. The claimServerTurn CAS (the same
    // worker_scope/heartbeat compare-and-set dispatchRun's worker path uses)
    // admits one of them; the loser returns without a turn instead of
    // interleaving a second one into agent_messages.
    let releaseTurn!: () => void;
    const turnStarted: Array<number> = [];
    const gate = new Promise<void>((res) => { releaseTurn = res; });
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "pi",
      async runTurn(args: any) {
        turnStarted.push(Date.now());
        await gate;
        args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
        args.onEvent({ type: "result", is_error: false, result: "ok", usage: {} });
        return { summary: "ok", resumeToken: null, turns: 1, inputTokens: 1, outputTokens: 1, totalCostUsd: 0 };
      },
    } as any);

    // Left at 'idle' on purpose: emitInboxEvent's own emit-time wake only fires
    // for 'parked' rows, so the ONLY drivers here are the two wakes below and the
    // race is deterministic.
    const run = await create(SERVER_CHAT);
    await emitInboxEvent({
      targetRunId: run.id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(run.id),
      payload: { summary: "child finished" },
    });

    const both = Promise.all([wakeServerRun(run.id), wakeServerRun(run.id)]);
    await vi.waitFor(() => expect(turnStarted.length).toBeGreaterThan(0));
    releaseTurn();
    await both;

    expect(turnStarted).toHaveLength(1);
    expect(await agentTexts(run.id)).toHaveLength(1);
    // Claim released in a finally, so the next user message is not starved.
    expect((await get(run.id))!.workerScope).toBeNull();
  });
});

describe("a server-runtime append takes the same single-owner claim", () => {
  it("rejects a user append while another process holds the run's claim", async () => {
    // The cross-process half of residual 2: the row is 'idle' (not a lease
    // status, so isLeaseLive is false) and there is no in-process runner, so
    // append's snapshot guard passes — only the claim CAS stops this second turn.
    const seen = stubBackend();
    const run = await create(SERVER_CHAT);
    await db
      .update(agentSessions)
      .set({ workerScope: "server-someone-else"})
      .where(eq(agentSessions.id, run.id));
    // The other owner is observably alive (provider verdict, not a clock).
    installFakeRunnerProvider();
    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "other" }, "other");

    const events: any[] = [];
    for await (const ev of append({ runId: run.id, role: "user", text: "hi" })) events.push(ev);

    // Today's "already in flight" contract, verbatim: an error frame and nothing
    // else. lib/pipe/agent-loop.ts finalizes the draft with it and the
    // per-conversation queue moves on — no half-written turn to unwind.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].error).toMatch(/already in flight/);
    expect(seen).toHaveLength(0);
    // No user row persisted, no status change, and the other owner's claim intact.
    expect(await db.select().from(agentMessages).where(eq(agentMessages.runId, run.id))).toHaveLength(0);
    const after = await get(run.id);
    expect(after!.status).toBe("idle");
    expect(after!.workerScope).toBe(`fake-runner-${run.id}`);
  });

  it("still takes over a STALE claim (a crashed process must not wedge the chat)", async () => {
    const seen = stubBackend();
    const run = await create(SERVER_CHAT);
    await db
      .update(agentSessions)
      .set({ workerScope: "server-dead-process"})
      .where(eq(agentSessions.id, run.id));

    for await (const ev of append({ runId: run.id, role: "user", text: "hi" })) void ev;

    expect(seen).toHaveLength(1);
    const after = await get(run.id);
    expect(after!.status).toBe("idle");
    // Our claim was released in the finally; the dead owner's scope is gone.
    expect(after!.workerScope).toBeNull();
  });

  it("lets exactly ONE of a user append and a concurrent wake drive a turn", async () => {
    // The full residual-2 race: a pipe user message and a web-process inbox wake
    // both pass their snapshot gates on an 'idle', unclaimed server row. Whoever
    // wins the claim drives; the loser rejects/no-ops. Either order is fine — what
    // must never happen is two turns interleaving into agent_messages.
    let releaseTurn!: () => void;
    const turnStarted: number[] = [];
    const gate = new Promise<void>((res) => { releaseTurn = res; });
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "pi",
      async runTurn(args: any) {
        turnStarted.push(Date.now());
        await gate;
        args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
        args.onEvent({ type: "result", is_error: false, result: "ok", usage: {} });
        return { summary: "ok", resumeToken: null, turns: 1, inputTokens: 1, outputTokens: 1, totalCostUsd: 0 };
      },
    } as any);

    // 'idle', so emitInboxEvent's own emit-time wake (parked rows only) stays out
    // of it and the two drivers below are the whole race.
    const run = await create(SERVER_CHAT);
    await emitInboxEvent({
      targetRunId: run.id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(run.id),
      payload: { summary: "child finished" },
    });

    const drain = async () => {
      for await (const ev of append({ runId: run.id, role: "user", text: "hi" })) void ev;
    };
    const both = Promise.all([drain(), wakeServerRun(run.id)]);
    await vi.waitFor(() => expect(turnStarted.length).toBeGreaterThan(0));
    releaseTurn();
    await both;

    expect(turnStarted).toHaveLength(1);
    expect(await agentTexts(run.id)).toHaveLength(1);
    const after = await get(run.id);
    expect(after!.workerScope).toBeNull();
    expect(after!.status).toBe("idle");
  });
});

describe("reconcile treats a dead server run as resumable, not failed", () => {
  it("demotes a stale-lease server run to 'idle'", async () => {
    const run = await create(SERVER_CHAT);
    // A web/pipe restart killed the turn mid-flight: an active status with a
    // heartbeat older than the stale window and no worker behind it.
    await db
      .update(agentSessions)
      .set({
        status: "running",
        workerScope: null,
      })
      .where(eq(agentSessions.id, run.id));

    await reconcileOrphanedRuns();

    const after = await get(run.id);
    // 'idle', never 'failed' — the next message or inbox wake resumes it
    // in-process; failing it would kill a live conversation on every deploy.
    expect(after!.status).toBe("idle");
    expect(after!.error).toBeNull();
  });

  it("still applies the worker policy to a demoted legacy server row", async () => {
    __resetDemotionWarnings();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await legacyUnsafeServerRun();
    await db
      .update(agentSessions)
      .set({
        goal: "<implement>",
        status: "running",
        workerScope: null,
      })
      .where(eq(agentSessions.id, id));

    await reconcileOrphanedRuns();

    // Not a server run for policy purposes: a non-resumable worker orphan fails.
    expect((await get(id))!.status).toBe("failed");
  });
});
