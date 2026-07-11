import { type NextRequest } from "next/server";
import * as agent from "@/lib/agent";

export const dynamic = "force-dynamic";

// SSE stream of session events. Replays past events first, then subscribes to
// the in-process bus. Closes when the session reaches a terminal state.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = parseInt(id, 10);
  if (!Number.isFinite(sessionId)) {
    return new Response("Bad id", { status: 400 });
  }
  const session = await agent.getSession(sessionId);
  if (!session) {
    return new Response("Not found", { status: 404 });
  }

  const sinceParam = req.nextUrl.searchParams.get("since");
  const limitParam = req.nextUrl.searchParams.get("limit");
  const sinceParsed = sinceParam ? parseInt(sinceParam, 10) : 0;
  const since = Number.isFinite(sinceParsed) ? sinceParsed : 0;
  // Cap the initial replay so a long session doesn't blow up a reconnecting
  // client. Live events stream in regardless once the replay completes.
  const limitParsed = limitParam ? parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(limitParsed) ? Math.max(1, Math.min(2000, limitParsed)) : 500;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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

      const finish = (event: { type: string; payload?: unknown }) => {
        if (event.type !== "status") return false;
        const payload = event.payload as { status?: string };
        return !!payload?.status && ["completed", "failed", "cancelled"].includes(payload.status);
      };

      // Subscribe BEFORE the replay read so an event emitted while we read the
      // DB (in particular the terminal status that ends the stream) is never
      // lost — a lost terminal event would leave the SSE stream open forever.
      // Live events that arrive during the replay are buffered and flushed
      // after it, preserving order.
      let replaying = true;
      const buffered: Parameters<Parameters<typeof agent.subscribe>[1]>[0][] = [];
      const unsubscribe = agent.subscribe(sessionId, (event) => {
        if (replaying) {
          buffered.push(event);
          return;
        }
        send(event);
        if (finish(event)) {
          send({ type: "_eos" });
          unsubscribe();
          try {
            controller.close();
          } catch {}
          closed = true;
        }
      });

      // Replay buffered events, capped to the requested limit so long
      // sessions don't blow up the initial frame.
      for (const e of await agent.getSessionEvents(sessionId, since, limit)) send(e);

      // Flush live events that arrived mid-replay, then go fully live.
      let terminal = !agent.isLive(sessionId);
      for (const e of buffered) {
        send(e);
        if (finish(e)) terminal = true;
      }
      replaying = false;

      if (terminal) {
        send({ type: "_eos" });
        unsubscribe();
        try {
          controller.close();
        } catch {}
        closed = true;
        return;
      }

      // Keep-alive ping every 15s.
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
