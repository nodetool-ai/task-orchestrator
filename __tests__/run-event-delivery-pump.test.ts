import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, initDb } from "../db";
import { agentMessages, agentSessions, inboxEvents, runInputs } from "../db/schema";
import { pumpRunEventDeliveries } from "../lib/run-event-delivery";

const dispatchRun = vi.fn();
vi.mock("../lib/run-dispatch", () => ({ dispatchRun }));
vi.mock("../lib/runs", () => ({ get: vi.fn(async (id: number) => ({ id, status: "parked", deliveryVersion: 2, workerScope: null })) }));

beforeAll(() => initDb());
beforeEach(async () => {
  dispatchRun.mockReset();
  await db.delete(runInputs); await db.delete(inboxEvents); await db.delete(agentMessages); await db.delete(agentSessions);
});

describe("run event delivery pump", () => {
  it("materializes parked inbox-only work and retries dispatch without duplicate messages", async () => {
    const [run] = await db.insert(agentSessions).values({ status: "parked", deliveryVersion: 2, goal: "<chat>" }).returning({ id: agentSessions.id });
    await db.insert(inboxEvents).values({ targetRunId: run.id, type: "run_event", payload: { event_type: "run.attempt_finished" }, sourceKind: "run" });
    dispatchRun.mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce(undefined);
    await pumpRunEventDeliveries();
    expect(await db.select().from(agentMessages)).toHaveLength(1);
    expect(await db.select().from(runInputs)).toHaveLength(1);
    await pumpRunEventDeliveries();
    expect(await db.select().from(agentMessages)).toHaveLength(1);
    expect(await db.select().from(runInputs)).toHaveLength(1);
    expect(dispatchRun).toHaveBeenCalledTimes(2);
  });
});
