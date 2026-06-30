// __tests__/reconcile-orphaned-runs.test.ts
//
// A process that dies mid-turn (e.g. OOM-killed) leaves its run in an active
// status ('running' etc.) forever — append's guard then rejects every new
// message as "already in flight". reconcileOrphanedRuns() self-heals these on
// boot using the heartbeat lease: stale heartbeat => orphaned => demote.
// A run live in ANOTHER process keeps its heartbeat fresh and must be spared.

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get, reconcileOrphanedRuns } from "../lib/runs";

const STALE = new Date(Date.now() - 10 * 60_000); // 10 min ago
const FRESH = new Date(Date.now() - 5_000); // 5 s ago

function setRun(id: number, status: string, heartbeatAt: Date | null) {
  db.update(agentSessions)
    .set({ status, heartbeatAt })
    .where(eq(agentSessions.id, id))
    .run();
}

describe("reconcileOrphanedRuns", () => {
  it("demotes a stale-heartbeat running chat run to idle", () => {
    const run = create({ goal: "<chat>", defer: true });
    setRun(run.id, "running", STALE);

    reconcileOrphanedRuns();

    expect(get(run.id)?.status).toBe("idle");
  });

  it("demotes a stale-heartbeat running implement run to failed with an error", () => {
    const run = create({ goal: "<implement>", defer: true });
    setRun(run.id, "running", STALE);

    reconcileOrphanedRuns();

    const after = get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/interrupt/i);
  });

  it("treats a NULL heartbeat in an active status as orphaned", () => {
    const run = create({ goal: "<chat>", defer: true });
    setRun(run.id, "preparing", null);

    reconcileOrphanedRuns();

    expect(get(run.id)?.status).toBe("idle");
  });

  it("spares an active run whose heartbeat is fresh (live in another process)", () => {
    const run = create({ goal: "<chat>", defer: true });
    setRun(run.id, "running", FRESH);

    reconcileOrphanedRuns();

    expect(get(run.id)?.status).toBe("running");
  });

  it("ignores runs already in a terminal/idle status", () => {
    const idle = create({ goal: "<chat>", defer: true });
    setRun(idle.id, "idle", STALE);
    const done = create({ goal: "<implement>", defer: true });
    setRun(done.id, "completed", STALE);

    reconcileOrphanedRuns();

    expect(get(idle.id)?.status).toBe("idle");
    expect(get(done.id)?.status).toBe("completed");
  });
});
