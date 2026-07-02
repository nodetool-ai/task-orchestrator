// __tests__/run-stream.test.ts
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { agentMessages, agentEvents } from "../db/schema";
import { create } from "../lib/runs";
import { readStreamSince, ZERO_CURSOR } from "../lib/run-stream";

function addEvent(runId: number, payload: object) {
  db.insert(agentEvents)
    .values({ sessionId: runId, type: "status", payload: JSON.stringify(payload), createdAt: new Date() })
    .run();
}
function addMessage(runId: number, role: string, text: string) {
  db.insert(agentMessages)
    .values({ runId, role, content: JSON.stringify([{ type: "text", text }]), createdAt: new Date() })
    .run();
}

describe("readStreamSince", () => {
  it("returns nothing for an empty run and a non-terminal verdict", () => {
    const run = create({ goal: "<chat>", defer: true });
    const r = readStreamSince(run.id, ZERO_CURSOR);
    expect(r.frames).toEqual([]);
    expect(r.terminal).toBe(false);
    expect(r.cursor).toEqual(ZERO_CURSOR);
  });

  it("emits new message and event frames and advances both cursors", () => {
    const run = create({ goal: "<chat>", defer: true });
    addEvent(run.id, { type: "status", status: "running" });
    addMessage(run.id, "agent", "hello");
    const r = readStreamSince(run.id, ZERO_CURSOR);
    expect(r.frames.map((f) => f.kind)).toEqual(["event", "message"]);
    expect(r.cursor.evtId).toBeGreaterThan(0);
    expect(r.cursor.msgId).toBeGreaterThan(0);
    expect(r.terminal).toBe(false);
  });

  it("does not re-emit rows at or below the cursor", () => {
    const run = create({ goal: "<chat>", defer: true });
    addMessage(run.id, "agent", "one");
    const first = readStreamSince(run.id, ZERO_CURSOR);
    addMessage(run.id, "agent", "two");
    const second = readStreamSince(run.id, first.cursor);
    expect(second.frames).toHaveLength(1);
    expect((second.frames[0] as any).message.content[0].text).toBe("two");
  });

  it("flags terminal on a non-idle terminal status event", () => {
    const run = create({ goal: "<implement>", defer: true });
    addEvent(run.id, { type: "status", status: "failed", error: "boom" });
    const r = readStreamSince(run.id, ZERO_CURSOR);
    expect(r.terminal).toBe(true);
  });

  it("does NOT flag terminal on idle", () => {
    const run = create({ goal: "<chat>", defer: true });
    addEvent(run.id, { type: "status", status: "idle" });
    expect(readStreamSince(run.id, ZERO_CURSOR).terminal).toBe(false);
  });
});
