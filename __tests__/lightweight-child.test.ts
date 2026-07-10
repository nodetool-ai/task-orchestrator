// __tests__/lightweight-child.test.ts
//
// Lightweight-child isolation (TASK_ORCH_LIGHTWEIGHT_ISOLATION). The lightweight
// tier (pi <chat> / pi <execute>, placement runtime='server') runs its turns in a
// memory-capped local Node child by default ('child'), reusing the worker claim +
// detached-spawn machinery; 'inprocess' preserves the original in-process path
// (resumeServerRun / append). This suite covers:
//   • dispatchRun routing: child → claim + spawn; inprocess → server-resumed
//   • create()'s executor path + sendMessageToRun's chat path flow through dispatchRun
//   • the concurrency cap + memory-aware admission (defer / never-fits)
//   • countInFlightLightweightChildren accounting

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import {
  create,
  get,
  countInFlightLightweightChildren,
  sendMessageToRun,
} from "../lib/runs";
import * as dispatch from "../lib/run-dispatch";
import {
  dispatchRun,
  lightweightAdmissionDecision,
  lightweightChildReserveMB,
  LIGHTWEIGHT_NONHEAP_OVERHEAD_MB,
} from "../lib/run-dispatch";
import * as repo from "../lib/repo";

// Stub the pi postgres-turn loop so any turn that does run completes fast and
// makes no real model call (mirrors placement-routing / dispatch-routing).
vi.mock("../lib/agent-backend/postgres-turn", () => ({
  runPostgresTurn: async () => ({
    envelopes: [],
    summary: null,
    resumeToken: null,
    totalCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    turns: 0,
  }),
}));

const FRESH = new Date(Date.now() - 5_000);

beforeEach(() => {
  // This suite exercises the production default explicitly.
  process.env.TASK_ORCH_LIGHTWEIGHT_ISOLATION = "child";
});

afterEach(async () => {
  process.env.TASK_ORCH_LIGHTWEIGHT_ISOLATION = "inprocess"; // restore suite default
  delete process.env.TASK_ORCH_LIGHTWEIGHT_MAX_CHILDREN;
  delete process.env.TASK_ORCH_LIGHTWEIGHT_MEMORY_MB;
  vi.restoreAllMocks();
  await db.delete(agentSessions);
});

async function setRun(id: number, patch: Record<string, unknown>): Promise<void> {
  await db.update(agentSessions).set(patch).where(eq(agentSessions.id, id));
}

// ── dispatchRun routing: child vs inprocess ─────────────────────────────────

describe("dispatchRun lightweight isolation routing", () => {
  it("child isolation: claims + spawns a child (never the in-process resume path)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    expect((await get(run.id))?.runtime).toBe("server");

    const spawn = vi.fn(() => 4242);
    const result = await dispatchRun(run.id, { spawn, admit: async () => "admit" as const });

    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    const row = await get(run.id);
    expect(row?.status).toBe("preparing");
    expect(row?.workerScope).toMatch(/^run-/); // a real worker claim, not server-*
    expect(row?.workerPid).toBe(4242);
  });

  it("inprocess isolation: routes to the server resume path and spawns nothing", async () => {
    process.env.TASK_ORCH_LIGHTWEIGHT_ISOLATION = "inprocess";
    const run = await create({ goal: "<chat>", defer: true });

    const spawn = vi.fn(() => 4242);
    const result = await dispatchRun(run.id, { spawn });

    expect(result).toBe("server-resumed");
    expect(spawn).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20)); // let the background turn settle
  });
});

// ── create() + sendMessageToRun flow through dispatchRun under child isolation ──

describe("create/wake paths under child isolation", () => {
  it("a lightweight executor create() dispatches (no in-process kickoff)", async () => {
    const plan = await repo.createPlan({ title: "Child Exec", date: "2026-07-02" });
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    await create({ goal: "<execute>", planId: plan.id, backend: "pi", defer: false } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a lightweight chat message dispatches a child + relays (no in-process append)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");

    const abort = new AbortController();
    const gen = sendMessageToRun({ runId: run.id, role: "user", text: "hi", abort });
    await gen.next(); // persist + dispatch happen before the first relayed frame
    abort.abort();
    await gen.return(undefined as never).catch(() => {});

    expect(spy).toHaveBeenCalledWith(run.id);
  });
});

// ── concurrency + memory-aware admission integration (dispatch-level) ────────

describe("lightweight admission at dispatch", () => {
  it("defers to 'pending' when admission says defer (cap/budget full)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(run.id, { spawn, admit: async () => "defer" as const });

    expect(result).toBe("deferred");
    expect(spawn).not.toHaveBeenCalled();
    const row = await get(run.id);
    expect(row?.status).toBe("pending");
    expect(row?.workerScope).toBeNull();
    expect(row?.heartbeatAt).not.toBeNull(); // pending-episode stamp for MAX_DEFER
  });

  it("fails the run on never-fits (a single child's reservation exceeds the host)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(run.id, { spawn, admit: async () => "never-fits" as const });

    expect(result).toBe("spawn-failed");
    expect(spawn).not.toHaveBeenCalled();
    expect((await get(run.id))?.status).toBe("failed");
  });
});

// ── pure memory-aware admission math ─────────────────────────────────────────

describe("lightweightAdmissionDecision (memory-aware)", () => {
  it("reserves heap cap + non-heap overhead", () => {
    process.env.TASK_ORCH_LIGHTWEIGHT_MEMORY_MB = "512";
    expect(lightweightChildReserveMB()).toBe(512 + LIGHTWEIGHT_NONHEAP_OVERHEAD_MB);
    process.env.TASK_ORCH_LIGHTWEIGHT_MEMORY_MB = "0";
    expect(lightweightChildReserveMB()).toBe(0); // uncapped ⇒ no memory gate
  });

  it("defers when workers + children already fill the host budget", () => {
    // budget = 2000 - 0 = 2000. one worker at 1024 + one child at 640 = 1664
    // used; 2000 - 1664 = 336 < 640 ⇒ no room for another child.
    const d = lightweightAdmissionDecision({
      childReserveMB: 640,
      workerCapMB: 1024,
      reserveMB: 0,
      maxChildren: 8,
      inFlightChildren: 1,
      inFlightWorkers: 1,
      memTotalMB: 2000,
      memAvailableMB: null,
    });
    expect(d).toBe("defer");
  });

  it("admits when the shared budget still has room for one more child", () => {
    const d = lightweightAdmissionDecision({
      childReserveMB: 640,
      workerCapMB: 1024,
      reserveMB: 0,
      maxChildren: 8,
      inFlightChildren: 0,
      inFlightWorkers: 0,
      memTotalMB: 4096,
      memAvailableMB: 4096,
    });
    expect(d).toBe("admit");
  });

  it("defers on the live MemAvailable floor even if the reservation budget fits", () => {
    const d = lightweightAdmissionDecision({
      childReserveMB: 640,
      workerCapMB: 0,
      reserveMB: 0,
      maxChildren: 8,
      inFlightChildren: 0,
      inFlightWorkers: 0,
      memTotalMB: 8192,
      memAvailableMB: 300, // momentary pressure below one child
    });
    expect(d).toBe("defer");
  });

  it("never-fits when one child's reservation exceeds the whole budget", () => {
    const d = lightweightAdmissionDecision({
      childReserveMB: 640,
      workerCapMB: 0,
      reserveMB: 0,
      maxChildren: 8,
      inFlightChildren: 0,
      inFlightWorkers: 0,
      memTotalMB: 512, // host smaller than one child's reservation
      memAvailableMB: 512,
    });
    expect(d).toBe("never-fits");
  });

  it("enforces the count cap independent of memory", () => {
    const d = lightweightAdmissionDecision({
      childReserveMB: 0, // memory gate off
      workerCapMB: 0,
      reserveMB: 0,
      maxChildren: 2,
      inFlightChildren: 2,
      inFlightWorkers: 0,
      memTotalMB: 64_000,
      memAvailableMB: 64_000,
    });
    expect(d).toBe("defer");
  });
});

// ── counting live children ──────────────────────────────────────────────────

describe("countInFlightLightweightChildren", () => {
  it("counts runtime='server' claims with a fresh heartbeat", async () => {
    const baseline = await countInFlightLightweightChildren();
    const run = await create({ goal: "<chat>", defer: true });
    await setRun(run.id, { status: "preparing", workerScope: "run-lw-1", heartbeatAt: FRESH });
    expect(await countInFlightLightweightChildren()).toBe(baseline + 1);

    // A stale claim (dead child) is not counted — its slot is reclaimable.
    await setRun(run.id, { heartbeatAt: new Date(Date.now() - 10 * 60_000) });
    expect(await countInFlightLightweightChildren()).toBe(baseline);
  });
});
