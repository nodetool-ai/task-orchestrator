import { type NextRequest } from "next/server";
import { resolveApiActor, unauthorizedResponse } from "@/lib/api-auth";
import { getRunOverview } from "@/lib/run-overview";
import { subscribeRunStreamAll } from "@/lib/run-stream-listener";
import type { RunIndexRow } from "@/lib/run-index";

export const dynamic = "force-dynamic";

// Push-based SSE feed for the unified /runs index (components/runs/runs-index.tsx),
// replacing the 6s poll of GET /api/runs/overview (which stays as the client's
// fallback). It re-reads getRunOverview() and streams the whole row set whenever
// ANY run changes, woken by the Postgres LISTEN/NOTIFY on 'run_stream' (migration
// 0001, fired on every agent_events / agent_messages insert — status transitions
// are mirrored into agent_events, so those fire it too) via lib/run-stream-listener.
//
// Unlike the per-run route it does not tail by cursor: the index only cares about
// the aggregate, so each wake triggers a debounced whole-overview refetch.
//
// Frame contract:
//   - `{ type:"rows", rows }` carries the full RunIndexRow[] (initial + on change)
//   - `{ type:"_eos" }` closes the stream (only for the unauthenticated case)
//
// Same auth posture as GET /api/runs/overview: an unauthenticated request is not
// an error — it gets a single empty-rows frame and a graceful close. An
// `Authorization: Bearer tot_…` that fails to verify is a 401 instead.
const PING_EVERY_MS = 15_000;
// Belt-and-suspenders: re-fetch on this cadence even without a NOTIFY, in case
// one is missed (e.g. the listen connection briefly dropped and reconnected).
const SAFETY_DRAIN_MS = 15_000;
// Busy runs insert agent events constantly; the index only reflects aggregate
// changes, so collapse a burst of NOTIFYs into a single trailing refetch.
const DEBOUNCE_MS = 750;

export async function GET(req: NextRequest) {
  const auth = await resolveApiActor(req);
  // A Bearer token that does not verify is a hard 401 rather than the empty
  // stream the cookie-less browser case gets (tui T-tui-11).
  if (!auth.ok) return unauthorizedResponse();
  const authed = auth.actor !== null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let cleanedUp = false;
      let unsubscribe: (() => void) | null = null;
      let safety: ReturnType<typeof setInterval> | null = null;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let debounce: ReturnType<typeof setTimeout> | null = null;
      // Last JSON-serialized rows payload actually sent, so we can skip no-op
      // re-renders when a refetch produced identical output.
      let lastSent: string | null = null;

      // Idempotent teardown: gate future writes AND release the LISTEN
      // subscription + intervals + debounce timer + controller exactly once.
      // `closed` only gates writes; cleanup frees resources, so an enqueue
      // failure in send()/ping() must trigger cleanup() — not merely set `closed`.
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        closed = true;
        unsubscribe?.();
        if (safety) clearInterval(safety);
        if (keepalive) clearInterval(keepalive);
        if (debounce) clearTimeout(debounce);
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
      // Enqueue an already-serialized SSE data payload (avoids re-stringifying
      // in the refetch hot path where we compare the serialized form anyway).
      const sendRaw = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
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

      // Unauthenticated: mirror the poll's "empty list, not an error" posture —
      // send one empty-rows frame, signal end-of-stream, and close. The client
      // treats `_eos` as "stop reconnecting, fall back to polling".
      if (!authed) {
        send({ type: "rows", rows: [] satisfies RunIndexRow[] });
        send({ type: "_eos" });
        cleanup();
        return;
      }

      // Refetch the whole overview and send it unless byte-identical to the last
      // sent payload. Coalesces concurrent wake-ups: while a refetch is in
      // flight, a further wake marks `pending` and re-runs once afterwards
      // (mirrors the per-run route's draining/pending pattern).
      let refetching = false;
      let pending = false;
      const refetch = async () => {
        if (closed) return;
        if (refetching) {
          pending = true;
          return;
        }
        refetching = true;
        try {
          do {
            pending = false;
            const rows = await getRunOverview();
            if (closed) return;
            const payload = JSON.stringify({ type: "rows", rows });
            if (payload !== lastSent) {
              lastSent = payload;
              sendRaw(payload);
              if (closed) return;
            }
          } while (pending && !closed);
        } catch {
          // transient read error — the safety interval will retry
        } finally {
          refetching = false;
        }
      };
      // Trailing debounce: the first wake schedules a refetch DEBOUNCE_MS out;
      // further wakes within the window are absorbed into that one refetch.
      const scheduleRefetch = () => {
        if (closed || debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          void refetch();
        }, DEBOUNCE_MS);
      };

      // Subscribe BEFORE the initial read so no insert between the first fetch
      // and the subscription is lost.
      try {
        unsubscribe = await subscribeRunStreamAll(() => scheduleRefetch());
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

      // Initial full frame (sent immediately, not debounced).
      await refetch();
      if (closed) {
        cleanup();
        return;
      }

      safety = setInterval(() => void refetch(), SAFETY_DRAIN_MS);
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
