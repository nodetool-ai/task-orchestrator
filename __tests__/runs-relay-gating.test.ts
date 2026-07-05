// __tests__/runs-relay-gating.test.ts
//
// FIX 2 (M5): sendMessageToRun captures the run_stream cursor BEFORE persisting
// its user message. When a turn is already in flight, that turn can emit its
// turn_done / terminal / failed marker in the window between the cursor snapshot
// and our insert — so the marker lands in the relayed stream AHEAD of our own
// user_message frame. The old relay closed on that marker, finalizing the caller's
// draft with the WRONG (previous) turn's text; our actual reply never arrived.
//
// Fix: relayRunStream ignores turn_done / failed-status / terminal-flag closes
// until it has first seen the message frame carrying our own user-message id.
// This drives relayRunStream directly (an exported test seam) with a hand-crafted
// cursor and rows so the "prior marker before our message" ordering is exact.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentSessions, agentMessages, agentEvents } from "../db/schema";
import { create, relayRunStream, type AppendStreamEvent } from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
});

afterEach(async () => {
  await db.delete(agentSessions);
});

async function insertEvent(runId: number, type: string, payload: object, at: Date) {
  const [row] = await db
    .insert(agentEvents)
    .values({ sessionId: runId, type, payload: JSON.stringify(payload), createdAt: at })
    .returning();
  return row.id;
}

async function insertMessage(
  runId: number,
  role: string,
  text: string,
  at: Date
) {
  const [row] = await db
    .insert(agentMessages)
    .values({ runId, role, content: JSON.stringify([{ type: "text", text }]), createdAt: at })
    .returning();
  return row.id;
}

async function drain(gen: AsyncGenerator<AppendStreamEvent>): Promise<AppendStreamEvent[]> {
  const out: AppendStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("relayRunStream cursor gating (FIX 2)", () => {
  it("skips a prior turn's turn_done that precedes our own user_message", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const t0 = Date.now();
    // Prior turn's marker, created in the race window (BEFORE our message).
    await insertEvent(run.id, "turn_done", {}, new Date(t0));
    // Our own user message.
    const ownId = await insertMessage(run.id, "user", "what's the weather?", new Date(t0 + 100));
    // Our reply, then OUR turn's marker.
    await insertMessage(run.id, "agent", "It is sunny.", new Date(t0 + 200));
    await insertEvent(run.id, "turn_done", {}, new Date(t0 + 300));

    const abort = new AbortController();
    // from cursor of 0/0 → the relay sees every row; ownMsgId gates the close.
    const events = await drain(relayRunStream(run.id, { msgId: 0, evtId: 0 }, abort, ownId));

    // The relay must NOT have closed on the prior turn_done: our reply is present,
    // and there is exactly one terminal frame — a `done` AFTER the reply.
    const doneCount = events.filter((e) => e.type === "done").length;
    expect(doneCount).toBe(1);
    const sawReply = events.some(
      (e) => e.type === "sdk" && JSON.stringify(e.sdk).includes("It is sunny.")
    );
    expect(sawReply).toBe(true);
    // Ordering: the reply is emitted before the sole `done`.
    const replyIdx = events.findIndex(
      (e) => e.type === "sdk" && JSON.stringify(e.sdk).includes("It is sunny.")
    );
    const doneIdx = events.findIndex((e) => e.type === "done");
    expect(replyIdx).toBeLessThan(doneIdx);
  });

  it("ignores a prior failed-status marker until our message appears", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const t0 = Date.now();
    // A prior turn's failed status lands ahead of our message. (idle is excluded
    // from the terminal flag, so this exercises the failed-status branch.)
    await insertEvent(run.id, "status", { status: "failed", error: "old turn boom" }, new Date(t0));
    const ownId = await insertMessage(run.id, "user", "hi", new Date(t0 + 100));
    await insertMessage(run.id, "agent", "hello back", new Date(t0 + 200));
    await insertEvent(run.id, "turn_done", {}, new Date(t0 + 300));

    const abort = new AbortController();
    const events = await drain(relayRunStream(run.id, { msgId: 0, evtId: 0 }, abort, ownId));

    // The prior failure was skipped (not surfaced as our error), our reply arrived,
    // and the relay closed on our own turn_done.
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "sdk" && JSON.stringify(e.sdk).includes("hello back"))).toBe(true);
    expect(events.filter((e) => e.type === "done").length).toBe(1);
  });

  it("stamps the persisted row (real DB id) onto relayed sdk frames", async () => {
    // The client dedups by DB id against the read-only /events tail, which
    // delivers the same rows to the sender in parallel. An id-less sdk frame
    // renders as a second copy of every assistant/tool message.
    const run = await create({ goal: "<chat>", defer: true });
    const t0 = Date.now();
    const ownId = await insertMessage(run.id, "user", "hi", new Date(t0));
    const agentId = await insertMessage(run.id, "agent", "hello back", new Date(t0 + 100));
    const [toolRow] = await db
      .insert(agentMessages)
      .values({
        runId: run.id,
        role: "tool",
        content: JSON.stringify([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
        createdAt: new Date(t0 + 200),
      })
      .returning();
    await insertEvent(run.id, "turn_done", {}, new Date(t0 + 300));

    const abort = new AbortController();
    const events = await drain(relayRunStream(run.id, { msgId: 0, evtId: 0 }, abort, ownId));

    const sdkFrames = events.filter((e) => e.type === "sdk");
    expect(sdkFrames.map((e) => e.message?.id)).toEqual([agentId, toolRow.id]);
    expect(sdkFrames.map((e) => e.message?.role)).toEqual(["agent", "tool"]);
  });
});
