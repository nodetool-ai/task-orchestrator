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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentMessages, agentSessions } from "../db/schema";
import * as backend from "../lib/agent-backend";
import * as dispatch from "../lib/run-dispatch";
import { create, get, listPendingRunIds, sendMessageToRun } from "../lib/runs";

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
    stubBackend();
    const spawn = vi.fn().mockResolvedValue(1234);

    const run = await create(SERVER_CHAT);
    const result = await dispatch.dispatchRun(run.id, { spawn });

    expect(result).toBe("server-runtime");
    expect(spawn).not.toHaveBeenCalled();
    // The wake is kicked off in the background so the pump isn't blocked on a
    // model turn; it still lands an in-process turn.
    await vi.waitFor(async () => expect(await agentTexts(run.id)).toHaveLength(1));
    const after = await get(run.id);
    expect(after!.workerScope).toBeNull();
    expect(after!.status).toBe("idle");
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
    const { emitInboxEvent } = await import("../lib/inbox");

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
    const after = await get(run.id);
    expect(after!.workerScope).toBeNull();
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
