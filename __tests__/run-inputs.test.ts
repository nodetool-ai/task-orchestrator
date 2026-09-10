import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, initDb } from "../db";
import { agentMessages, agentSessions, inboxEvents, runEventSubscriptions, runSourceEvents, runInputs, runTurns } from "../db/schema";
import { eq } from "drizzle-orm";
import { registerDefaultChildSubscriptionTx, publishAttemptFinishedTx } from "../lib/run-source-events";
import { enqueueMessageTx, materializeInboxEventsTx, claimRunTurn, completeRunTurnTx } from "../lib/run-inputs";

async function run(status = "pending") {
  const [row] = await db.insert(agentSessions).values({ status, goal: "<chat>", deliveryVersion: 2 }).returning({ id: agentSessions.id });
  return row.id;
}
async function message(runId: number, text: string) {
  const [row] = await db.insert(agentMessages).values({ runId, role: "user", content: JSON.stringify([{ type: "text", text }]) }).returning({ id: agentMessages.id });
  return row.id;
}

beforeAll(() => initDb());
beforeEach(async () => {
  await db.delete(runTurns); await db.delete(runInputs); await db.delete(inboxEvents); await db.delete(agentMessages); await db.delete(runEventSubscriptions); await db.delete(runSourceEvents); await db.delete(agentSessions);
});

describe("durable conversation inputs", () => {
  it("enqueues a user message with a run-local sequence", async () => {
    const id = await run(); const msg = await message(id, "hello");
    const input = await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }));
    expect(input.runId).toBe(id); expect(input.inputSeq).toBe(1); expect(input.status).toBe("pending");
  });
  it("deduplicates retry of the same message", async () => {
    const id = await run(); const msg = await message(id, "retry");
    const a = await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }));
    const b = await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }));
    expect(b.id).toBe(a.id); expect(b.inputSeq).toBe(a.inputSeq);
  });
  it("materializes one event delivery into one typed message and input", async () => {
    const id = await run();
    const [child] = await db.insert(agentSessions).values({ parentRunId: id, status: "pending", goal: "<implement>" }).returning();
    await db.transaction(tx => registerDefaultChildSubscriptionTx(tx, child));
    await db.transaction(tx => publishAttemptFinishedTx(tx, { id: child.id, attempt: 1, status: "completed" }));
    const refs = await db.transaction(tx => materializeInboxEventsTx(tx, id));
    expect(refs).toHaveLength(1); expect((await db.select().from(runInputs))).toHaveLength(1);
    expect((await db.select().from(inboxEvents))[0].status).toBe("injected");
  });
  it("allocates a manifest and recovers it on replacement", async () => {
    const id = await run(); const msg = await message(id, "turn");
    await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }));
    const first = await db.transaction(tx => claimRunTurn(tx, id, 4));
    const second = await db.transaction(tx => claimRunTurn(tx, id, 9));
    expect(second?.id).toBe(first?.id); expect(second?.executionGeneration).toBe(9);
  });
  it("retires an unfinished receipt when a corrective follow-up starts a new attempt", async () => {
    const id = await run();
    const firstMessage = await message(id, "initial");
    await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: firstMessage, kind: "user" }));
    const first = (await db.transaction(tx => claimRunTurn(tx, id, 4)))!;

    // The worker failed after claiming the first input. A corrective user
    // message arrives while the control plane advances the logical attempt.
    await db.update(agentSessions).set({ status: "pending", attempt: 2 }).where(eq(agentSessions.id, id));
    const correction = await message(id, "please fix that");
    await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: correction, kind: "user" }));

    // The attempt fence applies as soon as the logical attempt changes, even
    // before the replacement worker has claimed its new turn.
    expect(await db.transaction(tx => completeRunTurnTx(tx, {
      turnId: first.id, runId: id, workerGeneration: 4, instanceId: "late-old-worker",
      inputIds: first.inputs.map(input => input.id),
    }))).toBe(false);

    const next = (await db.transaction(tx => claimRunTurn(tx, id, 9)))!;
    expect(next.id).not.toBe(first.id);
    expect(next.inputs.map(input => input.messageId)).toEqual([correction]);
    const [oldTurn] = await db.select().from(runTurns).where(eq(runTurns.id, first.id));
    expect(oldTurn.state).toBe("superseded");
    const [oldInput] = await db.select().from(runInputs).where(eq(runInputs.id, first.inputs[0].id));
    expect(oldInput.status).toBe("cancelled");
  });
  it("completes only the exact receipt manifest", async () => {
    const id = await run(); const msg = await message(id, "turn");
    await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }));
    const turn = await db.transaction(tx => claimRunTurn(tx, id, 1));
    await expect(db.transaction(tx => completeRunTurnTx(tx, { turnId: turn!.id, runId: id, workerGeneration: 1, instanceId: "w", inputIds: ["00000000-0000-0000-0000-000000000000"] }))).rejects.toThrow();
    expect((await db.select().from(runInputs))[0].status).toBe("assigned");
  });
  it("rejects subset and empty receipts without completing any inputs", async () => {
    const id = await run();
    for (const text of ["one", "two"]) {
      const msg = await message(id, text);
      await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }));
    }
    const turn = (await db.transaction(tx => claimRunTurn(tx, id, 4)))!;
    expect(turn.ordinal).toBe(1);
    for (const inputIds of [[], [turn.inputs[0].id], turn.inputs.map(x => x.id).reverse()]) {
      await expect(db.transaction(tx => completeRunTurnTx(tx, { turnId: turn.id, runId: id, workerGeneration: 4, instanceId: "w", inputIds }))).rejects.toThrow("manifest");
    }
    expect((await db.select().from(runInputs)).every(x => x.status === "assigned")).toBe(true);
    await db.transaction(tx => claimRunTurn(tx, id, 9));
    expect(await db.transaction(tx => completeRunTurnTx(tx, { turnId: turn.id, runId: id, workerGeneration: 4, instanceId: "old", inputIds: turn.inputs.map(x => x.id) }))).toBe(false);
    expect(await db.transaction(tx => completeRunTurnTx(tx, { turnId: turn.id, runId: id, workerGeneration: 9, instanceId: "new", inputIds: turn.inputs.map(x => x.id) }))).toBe(true);
  });
  it("serializes simultaneous claims and queues arrivals for the next turn", async () => {
    const id = await run(); const msg = await message(id, "first");
    await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }));
    const [a, b] = await Promise.all([db.transaction(tx => claimRunTurn(tx, id, 1)), db.transaction(tx => claimRunTurn(tx, id, 1))]);
    expect(a!.id).toBe(b!.id);
    const nextMessage = await message(id, "later");
    await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: nextMessage, kind: "user" }));
    await db.transaction(tx => completeRunTurnTx(tx, { turnId: a!.id, runId: id, workerGeneration: 1, instanceId: "w", inputIds: a!.inputs.map(x => x.id) }));
    const next = (await db.transaction(tx => claimRunTurn(tx, id, 1)))!;
    expect(next.ordinal).toBe(2); expect(next.inputs.map(x => x.messageId)).toEqual([nextMessage]);
  });
  it("rejects enqueueing another run's message", async () => {
    const id = await run(); const other = await run(); const msg = await message(other, "other");
    await expect(db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }))).rejects.toThrow("belong");
  });
  it("does not replay a completed turn", async () => {
    const id = await run(); const msg = await message(id, "turn");
    await db.transaction(tx => enqueueMessageTx(tx, { runId: id, messageId: msg, kind: "user" }));
    const turn = await db.transaction(tx => claimRunTurn(tx, id, 1));
    await db.transaction(tx => completeRunTurnTx(tx, { turnId: turn!.id, runId: id, workerGeneration: 1, instanceId: "w", inputIds: turn!.inputs.map(x => x.id) }));
    expect(await db.transaction(tx => claimRunTurn(tx, id, 1))).toBeNull();
  });
  it("does not materialize control events", async () => {
    const id = await run(); await db.insert(inboxEvents).values({ targetRunId: id, type: "run.budget_exhausted", payload: {}, sourceKind: "budget" });
    expect(await db.transaction(tx => materializeInboxEventsTx(tx, id))).toHaveLength(0);
    expect((await db.select().from(inboxEvents))[0].status).toBe("pending");
  });
  it("suppresses pending events for terminal targets", async () => {
    const id = await run("completed"); await db.insert(inboxEvents).values({ targetRunId: id, type: "run_event", payload: {}, sourceKind: "run" });
    await db.transaction(tx => materializeInboxEventsTx(tx, id));
    expect((await db.select().from(inboxEvents))[0].status).toBe("superseded");
  });
});
