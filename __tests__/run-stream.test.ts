// __tests__/run-stream.test.ts
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { agentMessages, agentEvents } from "../db/schema";
import { create } from "../lib/runs";
import { readStreamSince, ZERO_CURSOR } from "../lib/run-stream";

async function addEvent(runId: number, payload: object) {
  await db.insert(agentEvents)
    .values({ sessionId: runId, type: "status", payload: JSON.stringify(payload), createdAt: new Date() });
}
async function addMessage(runId: number, role: string, text: string) {
  await db.insert(agentMessages)
    .values({ runId, role, content: JSON.stringify([{ type: "text", text }]), createdAt: new Date() });
}
// Mirrors how lib/runs.emitStatus actually persists: the event kind lives in the
// `type` column and the payload is JUST `{ status, ...extra }` (no `type` field).
async function addRealStatus(runId: number, status: string, extra: object = {}) {
  await db.insert(agentEvents)
    .values({ sessionId: runId, type: "status", payload: JSON.stringify({ status, ...extra }), createdAt: new Date() });
}

describe("readStreamSince", () => {
  it("returns nothing for an empty run and a non-terminal verdict", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const r = await readStreamSince(run.id, ZERO_CURSOR);
    expect(r.frames).toEqual([]);
    expect(r.terminal).toBe(false);
    expect(r.cursor).toEqual(ZERO_CURSOR);
  });

  it("emits new message and event frames and advances both cursors", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await addEvent(run.id, { type: "status", status: "running" });
    await addMessage(run.id, "agent", "hello");
    const r = await readStreamSince(run.id, ZERO_CURSOR);
    expect(r.frames.map((f) => f.kind)).toEqual(["event", "message"]);
    expect(r.cursor.evtId).toBeGreaterThan(0);
    expect(r.cursor.msgId).toBeGreaterThan(0);
    expect(r.terminal).toBe(false);
  });

  it("does not re-emit rows at or below the cursor", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await addMessage(run.id, "agent", "one");
    const first = await readStreamSince(run.id, ZERO_CURSOR);
    await addMessage(run.id, "agent", "two");
    const second = await readStreamSince(run.id, first.cursor);
    expect(second.frames).toHaveLength(1);
    expect((second.frames[0] as any).message.content[0].text).toBe("two");
  });

  it("flags terminal on a non-idle terminal status event", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await addEvent(run.id, { type: "status", status: "failed", error: "boom" });
    const r = await readStreamSince(run.id, ZERO_CURSOR);
    expect(r.terminal).toBe(true);
  });

  it("does NOT flag terminal on idle", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await addEvent(run.id, { type: "status", status: "idle" });
    expect((await readStreamSince(run.id, ZERO_CURSOR)).terminal).toBe(false);
  });

  it("surfaces the row `type` on the event frame for production-shaped payloads", async () => {
    // Real agent_events rows keep the kind in the column and omit it from the
    // JSON payload. The SSE contract the run view consumes is a flat
    // `{ type:"status", status }` frame, so readStreamSince must fold the
    // column back in.
    const run = await create({ goal: "<implement>", defer: true });
    await addRealStatus(run.id, "running");
    const r = await readStreamSince(run.id, ZERO_CURSOR);
    const data = (r.frames[0] as any).data;
    expect(data.type).toBe("status");
    expect(data.status).toBe("running");
    expect(r.terminal).toBe(false);
  });

  it("flags terminal on a production-shaped terminal status event", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await addRealStatus(run.id, "failed", { error: "boom" });
    const r = await readStreamSince(run.id, ZERO_CURSOR);
    expect((r.frames[0] as any).data.type).toBe("status");
    expect(r.terminal).toBe(true);
  });
});
