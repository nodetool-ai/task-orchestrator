import { type NextRequest } from "next/server";
import * as runs from "@/lib/runs";
import { isTerminalStatus, type SessionStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// Live SSE feed for /runs/[id]. Unlike POST /messages (which streams the
// reply to the caller's own turn), this endpoint is read-only: it forwards
// in-process bus events for the run so that a viewer who is *not* the one
// sending the message still sees status transitions, SDK envelopes, and
// system events as they happen. Closes when the run reaches a terminal,
// non-resumable status.
//
// NOTE: `runs.subscribe()` attaches to the bus that is alive *right now*.
// For implement-style runs the bus exists for the lifetime of the worker,
// so this works. For chat-style idle runs the bus is rebuilt per turn —
// the caller's own POST /messages SSE is the authoritative stream for
// that turn; this endpoint is best-effort for secondary viewers.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId)) {
    return new Response("Bad id", { status: 400 });
  }
  const run = runs.get(runId);
  if (!run) return new Response("Not found", { status: 404 });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Tell the client our current status so the UI can reconcile on
      // reconnect.
      send({ type: "status", status: run.status });

      // If the run is fully terminal (closed/completed/etc.) and there is
      // no live worker, close immediately. `idle` runs stay open because
      // appending a new message will revive the in-process bus.
      const terminallyClosed =
        isTerminalStatus(run.status) && run.status !== "idle";
      const live = runs.isLive(runId);
      if (terminallyClosed && !live) {
        send({ type: "_eos" });
        try {
          controller.close();
        } catch {}
        return;
      }

      const unsubscribe = runs.subscribe(runId, (event) => {
        send(event);
        const ev = event as { type?: string; status?: SessionStatus };
        if (ev.type === "status" && ev.status) {
          if (isTerminalStatus(ev.status) && ev.status !== "idle") {
            send({ type: "_eos" });
            unsubscribe();
            try {
              controller.close();
            } catch {}
            closed = true;
          }
        }
      });

      // Keep-alive ping every 15s (some proxies kill quiet streams).
      const ping = setInterval(() => {
        if (closed) {
          clearInterval(ping);
          return;
        }
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(ping);
          closed = true;
        }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(ping);
        try {
          controller.close();
        } catch {}
        closed = true;
      });
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
