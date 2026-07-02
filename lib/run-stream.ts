// lib/run-stream.ts
//
// Pure cursor tail over the already-incrementally-persisted agent_messages /
// agent_events tables. Clients (the SSE endpoint) stream a run by re-reading
// everything strictly after a monotonic-id cursor instead of subscribing to an
// in-process event bus — so a run's stream survives a web-server restart.
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { agentMessages, agentEvents } from "../db/schema";
import { isTerminalStatus, type SessionStatus } from "./types";
import { hydrateMessage, type MessageRow } from "./runs";

export type StreamCursor = { msgId: number; evtId: number };
export const ZERO_CURSOR: StreamCursor = { msgId: 0, evtId: 0 };

export type StreamFrame =
  | { kind: "event"; id: number; at: number; data: unknown }
  | { kind: "message"; id: number; at: number; message: MessageRow };

export function readStreamSince(
  runId: number,
  cursor: StreamCursor
): { frames: StreamFrame[]; cursor: StreamCursor; terminal: boolean } {
  const evts = db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, runId), gt(agentEvents.id, cursor.evtId)))
    .orderBy(asc(agentEvents.id))
    .all();
  const msgs = db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.runId, runId), gt(agentMessages.id, cursor.msgId)))
    .orderBy(asc(agentMessages.id))
    .all();

  const frames: StreamFrame[] = [];
  let terminal = false;
  for (const e of evts) {
    // The event kind lives in the `type` COLUMN; the payload is just the flat
    // body (e.g. `{ status, error }`). Fold the column back in so the emitted
    // frame matches the flat `{ type, ...payload }` contract the run view
    // consumes (and so terminal detection below can read `data.type`). A payload
    // that redundantly carries its own `type` (test fixtures) keeps it.
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(e.payload);
      body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      body = { payload: e.payload };
    }
    const data = { type: e.type, ...body };
    const d = data as { type?: string; status?: SessionStatus };
    if (d.type === "status" && d.status && isTerminalStatus(d.status) && d.status !== "idle") {
      terminal = true;
    }
    frames.push({ kind: "event", id: e.id, at: e.createdAt.getTime(), data });
  }
  for (const m of msgs) {
    frames.push({ kind: "message", id: m.id, at: m.createdAt.getTime(), message: hydrateMessage(m) });
  }
  frames.sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.id - b.id : a.kind === "event" ? -1 : 1));

  return {
    frames,
    cursor: {
      evtId: evts.length ? evts[evts.length - 1].id : cursor.evtId,
      msgId: msgs.length ? msgs[msgs.length - 1].id : cursor.msgId,
    },
    terminal,
  };
}
