// __tests__/run-stream-listener.test.ts
//
// End-to-end for the realtime path: inserting an agent_event / agent_message
// fires the migration-0001 trigger -> pg_notify('run_stream') -> the process
// listener -> the run's subscriber callback.
import { describe, it, expect } from "vitest";
import { db, schema } from "../db";
import { create } from "../lib/runs";
import { subscribeRunStream, type RunStreamEvent } from "../lib/run-stream-listener";

function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error("timed out waiting for notification"));
      }
    }, 20);
  });
}

describe("run-stream LISTEN/NOTIFY", () => {
  it("notifies a subscriber on a new agent_event", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const got: RunStreamEvent[] = [];
    const unsub = await subscribeRunStream(run.id, (ev) => got.push(ev));
    try {
      await db
        .insert(schema.agentEvents)
        .values({ sessionId: run.id, type: "status", payload: JSON.stringify({ status: "running" }) });
      await waitFor(() => got.some((e) => e.runId === run.id && e.kind === "agent_events"));
      const ev = got.find((e) => e.runId === run.id && e.kind === "agent_events")!;
      expect(ev.id).toBeGreaterThan(0);
    } finally {
      unsub();
    }
  });

  it("notifies on a new agent_message and stops after unsubscribe", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const got: RunStreamEvent[] = [];
    const unsub = await subscribeRunStream(run.id, (ev) => got.push(ev));
    await db
      .insert(schema.agentMessages)
      .values({ runId: run.id, role: "agent", content: JSON.stringify([{ type: "text", text: "hi" }]) });
    await waitFor(() => got.some((e) => e.kind === "agent_messages"));

    unsub();
    const countAfterUnsub = got.length;
    await db
      .insert(schema.agentMessages)
      .values({ runId: run.id, role: "agent", content: JSON.stringify([{ type: "text", text: "again" }]) });
    await new Promise((r) => setTimeout(r, 200));
    expect(got.length).toBe(countAfterUnsub); // no more callbacks after unsubscribe
  });
});
