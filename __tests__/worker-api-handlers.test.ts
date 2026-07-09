// __tests__/worker-api-handlers.test.ts
//
// The /api/worker/* surface, exercised directly through handleWorkerApi with
// plain Request objects (the Next catch-all route is a two-line shim over it).
// Uses the real per-fork Postgres schema like every other test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentMessages, agentSessions } from "../db/schema";
import * as repo from "../lib/repo";
import { create, get, listMessages } from "../lib/runs";
import { handleWorkerApi } from "../lib/worker/api-handlers";
import { WORKER_PROTOCOL_VERSION, WORKER_PROTOCOL_HEADER } from "../lib/worker/protocol";
import { mintWorkerToken } from "../lib/worker/token";

beforeAll(() => {
  process.env.TASK_ORCH_WORKER_API_SECRET = "handlers-test-secret";
});
afterAll(() => {
  delete process.env.TASK_ORCH_WORKER_API_SECRET;
});

function call(
  runId: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<Response> {
  const req = new Request(`http://orch.test/api/worker/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token ?? mintWorkerToken(runId)}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleWorkerApi(req, path.split("?")[0].split("/"));
}

async function json(res: Response): Promise<any> {
  expect(res.headers.get("content-type")).toContain("application/json");
  return res.json();
}

describe("worker API auth", () => {
  it("401s without a token and 403s a token for another run", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const noAuth = await handleWorkerApi(
      new Request(`http://orch.test/api/worker/runs/${run.id}`),
      ["runs", String(run.id)]
    );
    expect(noAuth.status).toBe(401);
    const wrongRun = await call(run.id, "GET", `runs/${run.id}`, undefined, mintWorkerToken(run.id + 1));
    expect(wrongRun.status).toBe(403);
  });

  it("404s unknown endpoints", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    expect((await call(run.id, "GET", `runs/${run.id}/nope`)).status).toBe(404);
  });
});

describe("worker API protocol version (R7a)", () => {
  function callVersioned(runId: number, protocol: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${mintWorkerToken(runId)}`,
    };
    if (protocol !== null) headers[WORKER_PROTOCOL_HEADER] = protocol;
    const path = `runs/${runId}`;
    return handleWorkerApi(
      new Request(`http://orch.test/api/worker/${path}`, { headers }),
      path.split("/")
    );
  }

  it("serves a request whose protocol major matches", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const res = await callVersioned(run.id, String(WORKER_PROTOCOL_VERSION));
    expect(res.status).toBe(200);
  });

  it("409s a protocol_mismatch with a structured body and does not retry-flag it", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const res = await callVersioned(run.id, String(WORKER_PROTOCOL_VERSION + 1));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "protocol_mismatch",
      server: WORKER_PROTOCOL_VERSION,
      client: WORKER_PROTOCOL_VERSION + 1,
    });
  });

  it("serves an unversioned (header-less) worker as legacy", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const res = await callVersioned(run.id, null);
    expect(res.status).toBe(200);
  });

  it("reports client:null when the header is non-numeric garbage", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const res = await callVersioned(run.id, "banana");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: "protocol_mismatch", server: WORKER_PROTOCOL_VERSION, client: null });
  });
});

describe("worker API run plane", () => {
  it("serves the run row", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const { run: fetched } = await json(await call(run.id, "GET", `runs/${run.id}`));
    expect(fetched.id).toBe(run.id);
    expect(fetched.status).toBe((await get(run.id))!.status);
  });

  it("appends and lists messages", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const posted = await json(
      await call(run.id, "POST", `runs/${run.id}/messages`, {
        role: "agent",
        content: [{ type: "text", text: "hello from a worker" }],
      })
    );
    expect(posted.message.role).toBe("agent");
    const { messages } = await json(await call(run.id, "GET", `runs/${run.id}/messages`));
    expect(messages.some((m: any) => m.id === posted.message.id)).toBe(true);
    // And the row is visible through the normal server-side read path.
    expect((await listMessages(run.id)).some((m) => m.id === posted.message.id)).toBe(true);
  });

  it("deduplicates retried message appends by idempotency key", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const body = {
      role: "agent",
      content: [{ type: "text", text: "only once" }],
      idempotencyKey: `test-message-${run.id}`,
    };

    const first = await json(await call(run.id, "POST", `runs/${run.id}/messages`, body));
    const second = await json(await call(run.id, "POST", `runs/${run.id}/messages`, body));

    expect(second.message.id).toBe(first.message.id);
    const rows = await db.select().from(agentMessages).where(eq(agentMessages.runId, run.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects a bad message role", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const res = await call(run.id, "POST", `runs/${run.id}/messages`, { role: "root", content: [] });
    expect(res.status).toBe(400);
  });

  it("appends events and counts them by type", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await call(run.id, "POST", `runs/${run.id}/events`, { type: "turn_done", payload: {} });
    await call(run.id, "POST", `runs/${run.id}/events`, { type: "turn_done", payload: {} });
    const res = await handleWorkerApi(
      new Request(`http://orch.test/api/worker/runs/${run.id}/events?type=turn_done`, {
        headers: { authorization: `Bearer ${mintWorkerToken(run.id)}` },
      }),
      ["runs", String(run.id), "events"]
    );
    expect((await json(res)).count).toBe(2);
  });

  it("lands a guarded status transition exactly once", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const first = await json(
      await call(run.id, "POST", `runs/${run.id}/status`, {
        mode: "cas",
        status: "failed",
        set: { error: "boom", completedAt: new Date().toISOString() },
        guard: "not-terminal",
        extra: { error: "boom" },
      })
    );
    expect(first.applied).toBe(true);
    // Idempotent replay: already terminal → guard matches 0 rows.
    const second = await json(
      await call(run.id, "POST", `runs/${run.id}/status`, {
        mode: "cas",
        status: "failed",
        set: { error: "later" },
        guard: "not-terminal",
      })
    );
    expect(second.applied).toBe(false);
    const row = (await get(run.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("boom"); // the replay did not overwrite
  });

  it("patches whitelisted run columns", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await call(run.id, "PATCH", `runs/${run.id}`, {
      patch: { branch: "claude/task-1", worktreePath: "/work/1", sdkSessionId: "sess-9" },
    });
    const row = (await get(run.id))!;
    expect(row.branch).toBe("claude/task-1");
    expect(row.worktreePath).toBe("/work/1");
    expect(row.sdkSessionId).toBe("sess-9");
  });

  it("heartbeats: bumps the lease and answers the cancel flag", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const before = (await get(run.id))!.heartbeatAt;
    const beat1 = await json(await call(run.id, "POST", `runs/${run.id}/heartbeat`, {}));
    expect(beat1.cancelRequested).toBe(false);
    const after = (await get(run.id))!.heartbeatAt;
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? 0);

    await db
      .update(agentSessions)
      .set({ cancelRequested: 1 })
      .where(eq(agentSessions.id, run.id));
    const beat2 = await json(await call(run.id, "POST", `runs/${run.id}/heartbeat`, {}));
    expect(beat2.cancelRequested).toBe(true);
  });

  it("releases the worker claim and lands a chat run idle", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db
      .update(agentSessions)
      .set({ status: "idle", workerScope: "run-x", workerPid: 1234 })
      .where(eq(agentSessions.id, run.id));
    const res = await call(run.id, "POST", `runs/${run.id}/release`, {
      lastProcessedUserMsgId: 0,
      idleIfNonTerminal: true,
    });
    expect(res.status).toBe(200);
    const row = (await get(run.id))!;
    expect(row.workerScope).toBeNull();
    expect(row.workerPid).toBeNull();
    expect(row.status).toBe("idle");
  });

  it("claims an empty inbox as a null digest and stores worker logs", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const { digest } = await json(await call(run.id, "POST", `runs/${run.id}/inbox/claim`, {}));
    expect(digest).toBeNull();
    await call(run.id, "POST", `runs/${run.id}/log`, { tail: "boot ok\nturn started\n" });
    const row = await db
      .select({ log: agentSessions.workerLog })
      .from(agentSessions)
      .where(eq(agentSessions.id, run.id));
    expect(row[0].log).toContain("turn started");
  });
});

describe("worker API domain plane", () => {
  it("serves task/plan context and enforces write scoping", async () => {
    const plan = await repo.createPlan({ title: "Worker API plan", date: "2026-07-06" });
    const task = await repo.createTask({ planId: plan.id, title: "T", date: "2026-07-06" });
    const otherTask = await repo.createTask({ planId: plan.id, title: "T2", date: "2026-07-06" });
    const run = await create({ goal: "<implement>", taskId: task.id, defer: true });

    const got = await json(await call(run.id, "GET", `tasks/${task.id}`));
    expect(got.task.id).toBe(task.id);
    const plans = await json(await call(run.id, "GET", `plans/${plan.id}/tasks`));
    expect(plans.tasks.length).toBe(2);

    // Transitioning the run's OWN task works…
    const ok = await call(run.id, "POST", `tasks/${task.id}/transition`, {
      state: "in_progress",
      assignee: "claude-agent",
    });
    expect(ok.status).toBe(200);
    expect((await repo.getTask(task.id))!.state).toBe("in_progress");
    // …but another task is forbidden.
    const forbidden = await call(run.id, "POST", `tasks/${otherTask.id}/transition`, {
      state: "in_progress",
    });
    expect(forbidden.status).toBe(403);
  });

  it("403s reads outside the run's task/plan scope", async () => {
    const planA = await repo.createPlan({ title: "Scoped plan", date: "2026-07-06" });
    const taskA = await repo.createTask({ planId: planA.id, title: "mine", date: "2026-07-06" });
    const planB = await repo.createPlan({ title: "Unrelated plan", date: "2026-07-06" });
    const taskB = await repo.createTask({ planId: planB.id, title: "other", date: "2026-07-06" });
    const run = await create({ goal: "<implement>", taskId: taskA.id, defer: true });

    // Own task + its parent plan: allowed.
    expect((await call(run.id, "GET", `tasks/${taskA.id}`)).status).toBe(200);
    expect((await call(run.id, "GET", `plans/${planA.id}`)).status).toBe(200);
    // Foreign task/plan: forbidden, even read-only.
    expect((await call(run.id, "GET", `tasks/${taskB.id}`)).status).toBe(403);
    expect((await call(run.id, "GET", `plans/${planB.id}`)).status).toBe(403);
    expect((await call(run.id, "GET", `plans/${planB.id}/tasks`)).status).toBe(403);
    // Persona reads are scoped to the run's own persona.
    expect((await call(run.id, "GET", `personas/implementor`)).status).toBe(200);
    expect((await call(run.id, "GET", `personas/reviewer`)).status).toBe(403);
  });

  it("executes orchestrator tools server-side with the token run's context", async () => {
    const plan = await repo.createPlan({ title: "Tool plan", date: "2026-07-06" });
    const run = await create({ goal: "<chat>", defer: true });
    const { result } = await json(
      await call(run.id, "POST", `runs/${run.id}/tools/call`, {
        tool: "get_plan",
        params: { id: plan.id },
        ctx: { author: "worker-test" },
      })
    );
    expect(result.isError ?? false).toBe(false);
    expect(JSON.stringify(result.content)).toContain(plan.id);
  });
});
