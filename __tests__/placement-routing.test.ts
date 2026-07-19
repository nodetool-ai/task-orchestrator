// __tests__/placement-routing.test.ts
//
// R1 (persisted placement) + R2 (server-side turn claim).
//
// Root cause of the run-131 incident: WHERE a run executes was re-derived from
// env predicates at every dispatch site, so a plan-executor that started in the
// server's in-process lightweight loop could be WOKEN into a Fly worker (where
// the loop — which needs DB access — can't run). The fix records placement ONCE
// on the row (agent_runs.runtime) and makes dispatchRun route on it:
//   • runtime='server' → the in-process server resume path (never a worker)
//   • runtime='worker' → today's provider path
// R2 gives the server path the same single-owner claim the worker path already
// had, so duplicate wakes (inbox emit racing the pump sweep) can't drive two
// coordinator turns at once, and a crashed server turn's stale claim is still
// reaped by the orphan reaper.

import { describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import {
  create,
  get,
  claimServerTurn,
  countInFlightWorkers,
  listMessages,
  releaseServerTurn,
  resumeServerRun,
  withServerClaim,
  reconcileOrphanedRuns,
} from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";
import * as repo from "../lib/repo";

// The postgres-mode loop the server resume path drives through runOneTurn (R3)
// — stub it so a resumed turn completes fast and harmlessly.
const chatTurns = vi.fn(async () => ({
  envelopes: [],
  summary: null,
  resumeToken: null,
  totalCostUsd: null,
  inputTokens: null,
  outputTokens: null,
  turns: 0,
}));
vi.mock("../lib/agent-backend/postgres-turn", () => ({
  runPostgresTurn: (...args: unknown[]) => chatTurns(...(args as [])),
}));

const STALE = new Date(Date.now() - 10 * 60_000);
const FRESH = new Date(Date.now() - 5_000);

afterEach(() => {
  delete process.env.TASK_ORCH_LIGHTWEIGHT_EXECUTOR;
  delete process.env.TASK_ORCH_LIGHTWEIGHT_CHATS;
  delete process.env.TASK_ORCH_INSIDE_WORKER;
  delete process.env.TASK_ORCH_AGENT_BACKEND;
  chatTurns.mockClear();
  vi.restoreAllMocks();
});

async function setRun(id: number, patch: Record<string, unknown>): Promise<void> {
  await db.update(agentSessions).set(patch).where(eq(agentSessions.id, id));
}

// ── R1: placement resolved + persisted at create ────────────────────────────

describe("resolvePlacement persisted at create()", () => {
  it("lightweight pi executor is placed on the server", async () => {
    const plan = await repo.createPlan({ title: "Placement Exec", date: "2026-07-02" });
    const run = await create({ goal: "<execute>", planId: plan.id, defer: true } as any);
    expect((await get(run.id))?.runtime).toBe("server");
  });

  it("lightweight pi chat is placed on the server", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    expect((await get(run.id))?.runtime).toBe("server");
    expect((await get(run.id))?.backend).toBe("pi");
  });

  it("persists a claude deployment default with worker placement", async () => {
    process.env.TASK_ORCH_AGENT_BACKEND = "claude";
    const plan = await repo.createPlan({ title: "Claude Default Exec", date: "2026-07-02" });
    const executor = await create({ goal: "<execute>", planId: plan.id, defer: true } as any);
    const chat = await create({ goal: "<chat>", defer: true });

    expect((await get(executor.id))?.backend).toBe("claude");
    expect((await get(executor.id))?.runtime).toBe("worker");
    expect((await get(chat.id))?.backend).toBe("claude");
    expect((await get(chat.id))?.runtime).toBe("worker");
  });

  it("keeps a pi deployment default on the server postgres path", async () => {
    process.env.TASK_ORCH_AGENT_BACKEND = "pi";
    const plan = await repo.createPlan({ title: "Pi Default Exec", date: "2026-07-02" });
    const run = await create({ goal: "<execute>", planId: plan.id, defer: true } as any);

    expect((await get(run.id))?.backend).toBe("pi");
    expect((await get(run.id))?.runtime).toBe("server");
  });

  it("an implement run is placed on a worker", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    expect((await get(run.id))?.runtime).toBe("worker");
  });

  it("a claude-backed executor is placed on a worker (not the lightweight loop)", async () => {
    const plan = await repo.createPlan({ title: "Claude Exec", date: "2026-07-02" });
    const run = await create({
      goal: "<execute>",
      planId: plan.id,
      backend: "claude",
      defer: true,
    } as any);
    expect((await get(run.id))?.runtime).toBe("worker");
  });

  it("an executor is placed on a worker when the lightweight loop is disabled", async () => {
    process.env.TASK_ORCH_LIGHTWEIGHT_EXECUTOR = "0";
    const plan = await repo.createPlan({ title: "Heavy Exec", date: "2026-07-02" });
    const run = await create({ goal: "<execute>", planId: plan.id, defer: true } as any);
    expect((await get(run.id))?.runtime).toBe("worker");
  });

  it("a raw-inserted row (no create()) backfills to 'worker'", async () => {
    // Mirrors the migration default: any row not born through resolvePlacement
    // takes the worker path, so existing rows keep their pre-change behavior.
    const inserted = await db
      .insert(agentSessions)
      .values({ goal: "<execute>", status: "pending", startedAt: new Date() })
      .returning();
    expect(inserted[0].runtime).toBe("worker");
  });
});

// ── R2: dispatchRun routes 'server' placement, never spawns a provider ──────

describe("dispatchRun placement routing", () => {
  it("routes a server-placement run to the resume path and spawns no worker", async () => {
    const plan = await repo.createPlan({ title: "Route Server", date: "2026-07-02" });
    const run = await create({ goal: "<execute>", planId: plan.id, defer: true } as any);
    expect((await get(run.id))?.runtime).toBe("server");

    const spawn = vi.fn(() => 4242);
    const result = await dispatchRun(run.id, { spawn });

    expect(result).toBe("server-resumed");
    expect(spawn).not.toHaveBeenCalled();
    // The run must NOT have taken a worker claim (scope 'run-<id>-...').
    const row = await get(run.id);
    expect(row?.workerScope == null || row.workerScope.startsWith("server-")).toBe(true);
    // dispatchRun returns 'server-resumed' BEFORE the fire-and-forget turn runs
    // (`void resumeServerRun(...)`). Await its landing deterministically: the old
    // fixed 20ms sleep let the turn leak into LATER tests' chatTurns call counts
    // on slow machines (its runPostgresTurn call showed up under the
    // duplicate-wake tests, failing them with an extra, execute-scaffold call).
    // The run starts 'idle', so status alone can look "settled" BEFORE the
    // background turn has even claimed it — require the turn to have actually
    // run (chatTurns called) and its claim to be released again.
    const deadline = Date.now() + 5000;
    for (;;) {
      const settled = await get(run.id);
      if (
        chatTurns.mock.calls.length >= 1 &&
        settled &&
        !["pending", "preparing", "running"].includes(settled.status) &&
        settled.workerScope == null
      ) {
        break;
      }
      if (Date.now() > deadline) throw new Error("background server turn did not settle");
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it("still spawns a worker for a worker-placement run", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const spawn = vi.fn(() => 5555);
    const result = await dispatchRun(run.id, { spawn });
    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

// ── R2: server-turn claim — single owner, release only if owner ─────────────

describe("claimServerTurn / releaseServerTurn", () => {
  it("claims only once: a second claim on the held row fails", async () => {
    const run = await create({ goal: "<execute>", defer: true });
    const first = await claimServerTurn(run.id);
    const second = await claimServerTurn(run.id);

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    const row = await get(run.id);
    expect(row?.status).toBe("preparing");
    expect(row?.workerScope).toBe(first.scope);
  });

  it("concurrent claims yield exactly one winner (atomic CAS)", async () => {
    const run = await create({ goal: "<execute>", defer: true });
    const results = await Promise.all([
      claimServerTurn(run.id),
      claimServerTurn(run.id),
      claimServerTurn(run.id),
    ]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it("release only clears the claim for the owning scope", async () => {
    const run = await create({ goal: "<execute>", defer: true });
    const { scope } = await claimServerTurn(run.id);

    await releaseServerTurn(run.id, "server-someone-else");
    expect((await get(run.id))?.workerScope).toBe(scope); // not ours → untouched

    await releaseServerTurn(run.id, scope);
    expect((await get(run.id))?.workerScope).toBeNull(); // owner → cleared
  });

  it("restores the pre-claim status when the drive throws before landing", async () => {
    const run = await create({ goal: "<chat>", defer: true });

    await expect(
      withServerClaim(run.id, async () => {
        throw new Error("pre-drive read failed");
      })
    ).rejects.toThrow("pre-drive read failed");

    const row = await get(run.id);
    expect(row?.status).toBe("idle");
    expect(row?.workerScope).toBeNull();
  });

  it("does not restore preparing after a successful drive", async () => {
    const run = await create({ goal: "<chat>", defer: true });

    await withServerClaim(run.id, async () => {
      await setRun(run.id, { status: "parked" });
    });

    const row = await get(run.id);
    expect(row?.status).toBe("parked");
    expect(row?.workerScope).toBeNull();
  });
});

describe("worker admission accounting", () => {
  it("excludes server claims but counts fresh worker claims", async () => {
    const baseline = await countInFlightWorkers();
    const serverRun = await create({ goal: "<chat>", defer: true });
    const serverClaim = await claimServerTurn(serverRun.id);
    expect(serverClaim.claimed).toBe(true);
    expect(await countInFlightWorkers()).toBe(baseline);

    const workerRun = await create({ goal: "<implement>", defer: true });
    await setRun(workerRun.id, {
      status: "preparing",
      workerScope: "run-test-worker",
      heartbeatAt: FRESH,
    });
    expect(await countInFlightWorkers()).toBe(baseline + 1);

    await releaseServerTurn(serverRun.id, serverClaim.scope);
    await setRun(workerRun.id, { workerScope: null });
  });
});

// ── R2: resumeServerRun short-circuits a duplicate wake ─────────────────────

describe("resumeServerRun duplicate-wake short-circuit", () => {
  it("does not drive a turn when the run is already claimed", async () => {
    const plan = await repo.createPlan({ title: "Held Exec", date: "2026-07-02" });
    const run = await create({ goal: "<execute>", planId: plan.id, defer: true } as any);
    // Simulate an in-flight turn already holding the claim.
    await setRun(run.id, { status: "running", workerScope: "server-held", heartbeatAt: FRESH });

    await resumeServerRun(run.id);

    expect(chatTurns).not.toHaveBeenCalled(); // the losing wake drove nothing
    const row = await get(run.id);
    expect(row?.workerScope).toBe("server-held"); // untouched by the loser
    expect(row?.status).toBe("running");
  });

  it("delivers a pure event wake ephemerally without persisting a user row", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    expect(await listMessages(run.id)).toHaveLength(0);

    await resumeServerRun(run.id);

    expect(await listMessages(run.id)).toHaveLength(0);
    expect(chatTurns).toHaveBeenCalledTimes(1);
    const [turnArgs] = chatTurns.mock.calls[0] as unknown as [{
      prompt: string;
      contextSource: { kind: string; ephemeralInput: boolean };
    }];
    expect(turnArgs.prompt).toContain("Resume this run");
    expect(turnArgs.contextSource).toMatchObject({ kind: "postgres", ephemeralInput: true });
  });
});

// ── R2: the orphan reaper recovers a crashed server turn ────────────────────

describe("reconcileOrphanedRuns and server claims", () => {
  it("reaps a stale server-claimed executor turn (recoverable, not wedged)", async () => {
    const run = await create({ goal: "<execute>", defer: true });
    // A server turn that crashed mid-flight: lease status, server claim, stale beat.
    await setRun(run.id, { status: "running", workerScope: "server-dead", heartbeatAt: STALE });

    await reconcileOrphanedRuns();

    // Recovered out of the wedged 'running' lease (an executor is non-resumable,
    // so it lands 'failed' — the point is it is no longer stuck in flight).
    expect((await get(run.id))?.status).toBe("failed");
  });

  it("does NOT reap a live server turn (fresh heartbeat keeps the lease)", async () => {
    const run = await create({ goal: "<execute>", defer: true });
    await setRun(run.id, { status: "running", workerScope: "server-live", heartbeatAt: FRESH });

    await reconcileOrphanedRuns();

    expect((await get(run.id))?.status).toBe("running"); // spared — still live
  });
});
