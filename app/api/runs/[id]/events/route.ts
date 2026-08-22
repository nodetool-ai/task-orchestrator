import { type NextRequest } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import * as runs from "@/lib/runs";
import { readStreamSince, ZERO_CURSOR, type StreamCursor } from "@/lib/run-stream";
import { subscribeRunStream } from "@/lib/run-stream-listener";

export const dynamic = "force-dynamic";

// Live SSE feed for /runs/[id]. Read-only: a viewer who is *not* the one sending
// the message still sees status transitions, system events, and assistant/tool
// messages as they happen.
//
// It streams by TAILING the already-incrementally-persisted agent_events /
// agent_messages tables by monotonic-id cursor (see lib/run-stream), woken by a
// Postgres LISTEN/NOTIFY (migration 0001 fires 'run_stream' on every insert) via
// lib/run-stream-listener. No in-process event bus and no fixed-interval poll, so
// the stream survives a web-server restart and a detached worker's progress
// reaches the client from another process, at push (sub-second) latency.
//
// Frame contract (unchanged for the run view):
//   - event frames are forwarded verbatim, preserving `{ type:"status", status }`
//   - message frames are wrapped as `{ type:"message", message }`
//   - a `{ type:"_cursor", cursor }` frame follows each non-empty batch so the
//     client can resume without gaps
//   - a terminal, non-idle status closes the stream with `{ type:"_eos" }`
const PING_EVERY_MS = 15_000;
// Belt-and-suspenders: re-drain on this cadence even without a NOTIFY, in case
// one is missed (e.g. the listen connection briefly dropped and reconnected).
const SAFETY_DRAIN_MS = 5_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireBearer(req);
  if (denied) return denied;
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
      let cleanedUp = false;
      let unsubscribe: (() => void) | null = null;
      let safety: ReturnType<typeof setInterval> | null = null;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      // Idempotent teardown: gate future writes AND release the LISTEN
      // subscription + intervals + controller exactly once. `closed` only gates
      // writes; cleanup is what actually frees resources, so an enqueue failure
      // in send()/ping() must trigger cleanup() — not merely set `closed` (which
      // used to leave the subscription + intervals leaked).
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        closed = true;
        unsubscribe?.();
        if (safety) clearInterval(safety);
        if (keepalive) clearInterval(keepalive);
        try {
          controller.close();
        } catch {}
      };
      const send = (o: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const ping = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      };

      req.signal.addEventListener("abort", cleanup);
      // The request may already be aborted before start() runs.
      if (req.signal.aborted) {
        cleanup();
        return;
      }

      // Drain every row after the cursor; on a terminal non-idle status, close.
      // Coalesces concurrent wake-ups so a burst of NOTIFYs collapses into one
      // catch-up read.
      let draining = false;
      let pending = false;
      const drainOnce = async (): Promise<boolean> => {
        const { frames, cursor: next, terminal } = await readStreamSince(runId, cursor);
        cursor = next;
        if (frames.length) {
          for (const f of frames) {
            if (f.kind === "event") send(f.data);
            else send({ type: "message", message: f.message });
          }
          send({ type: "_cursor", cursor });
        }
        return terminal;
      };
      const drain = async () => {
        if (closed) return;
        if (draining) {
          pending = true;
          return;
        }
        draining = true;
        try {
          do {
            pending = false;
            if (await drainOnce()) {
              send({ type: "_eos" });
              cleanup();
              return;
            }
          } while (pending && !closed);
        } catch {
          // transient read error — the safety interval will retry
        } finally {
          draining = false;
        }
      };

      // Subscribe BEFORE the initial drain so no insert between the first read
      // and the subscription is lost.
      try {
        unsubscribe = await subscribeRunStream(runId, () => void drain());
      } catch {
        // If LISTEN can't be established, the safety interval still delivers.
      }
      if (closed) {
        // Client bailed DURING subscribe: cleanup() already ran from the abort
        // handler (with unsubscribe still null), so calling it again is a no-op.
        // Release the just-assigned subscription directly.
        unsubscribe?.();
        return;
      }

      await drain();
      if (closed) {
        cleanup();
        return;
      }

      safety = setInterval(() => void drain(), SAFETY_DRAIN_MS);
      keepalive = setInterval(ping, PING_EVERY_MS);
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
