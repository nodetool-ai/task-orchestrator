import { type NextRequest } from "next/server";
import * as runs from "@/lib/runs";
import { readStreamSince, ZERO_CURSOR, type StreamCursor } from "@/lib/run-stream";

export const dynamic = "force-dynamic";

// Live SSE feed for /runs/[id]. Unlike POST /messages (which streams the reply
// to the caller's own turn), this endpoint is read-only: a viewer who is *not*
// the one sending the message still sees status transitions, system events, and
// assistant/tool messages as they happen.
//
// It streams by TAILING the already-incrementally-persisted agent_events /
// agent_messages tables by monotonic-id cursor (see lib/run-stream) rather than
// subscribing to an in-process event bus. That makes the stream survive a
// web-server restart and lets a detached worker's progress reach the client
// even though the worker runs in a different process.
//
// Frame contract (unchanged for the run view):
//   - event frames are forwarded verbatim, preserving `{ type:"status", status }`
//   - message frames are wrapped as `{ type:"message", message }`
//   - a `{ type:"_cursor", cursor }` frame follows each non-empty batch so the
//     client can resume without gaps
//   - a terminal, non-idle status closes the stream with `{ type:"_eos" }`
const POLL_ACTIVE_MS = 150;
const POLL_IDLE_MS = 1000;
const IDLE_BACKOFF_AFTER = 20; // empty polls before backing off
const PING_EVERY_MS = 15_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId)) return new Response("Bad id", { status: 400 });
  if (!(await runs.get(runId))) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  let cursor: StreamCursor = {
    msgId: parseInt(url.searchParams.get("msgCursor") ?? "", 10) || ZERO_CURSOR.msgId,
    evtId: parseInt(url.searchParams.get("evtCursor") ?? "", 10) || ZERO_CURSOR.evtId,
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (o: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const ping = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      };

      req.signal.addEventListener("abort", () => {
        closed = true;
        try {
          controller.close();
        } catch {}
      });

      let emptyPolls = 0;
      let sinceLastPing = 0;
      while (!closed) {
        const { frames, cursor: next, terminal } = await readStreamSince(runId, cursor);
        cursor = next;
        if (frames.length) {
          emptyPolls = 0;
          for (const f of frames) {
            if (f.kind === "event") send(f.data);
            else send({ type: "message", message: f.message });
          }
          send({ type: "_cursor", cursor });
        } else {
          emptyPolls++;
        }
        if (terminal) {
          send({ type: "_eos" });
          break;
        }
        const wait = emptyPolls >= IDLE_BACKOFF_AFTER ? POLL_IDLE_MS : POLL_ACTIVE_MS;
        sinceLastPing += wait;
        if (sinceLastPing >= PING_EVERY_MS) {
          ping();
          sinceLastPing = 0;
        }
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        controller.close();
      } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
