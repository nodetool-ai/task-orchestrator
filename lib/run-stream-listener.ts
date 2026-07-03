// lib/run-stream-listener.ts
//
// Process-wide Postgres LISTEN on the 'run_stream' channel (fired by the
// agent_events / agent_messages AFTER INSERT triggers in migration 0001). One
// dedicated listen connection fans out to in-process subscribers keyed by
// run_id, so the SSE endpoint can wait on the DB for new rows instead of
// polling. The NOTIFY payload is only a wakeup — subscribers re-read the actual
// rows via the cursor tail (lib/run-stream).
import { sql } from "../db";

export type RunStreamEvent = { runId: number; kind: string; id: number };
type Callback = (ev: RunStreamEvent) => void;

// Reuse across HMR / module reloads via a global (mirrors the db singleton).
declare global {
  // eslint-disable-next-line no-var
  var __runStreamSubs: Map<number, Set<Callback>> | undefined;
  // eslint-disable-next-line no-var
  var __runStreamListen: Promise<void> | undefined;
}

const subscribers: Map<number, Set<Callback>> =
  globalThis.__runStreamSubs ?? (globalThis.__runStreamSubs = new Map());

function ensureListening(): Promise<void> {
  if (globalThis.__runStreamListen) return globalThis.__runStreamListen;
  globalThis.__runStreamListen = (async () => {
    await sql.listen("run_stream", (payload: string) => {
      let ev: RunStreamEvent;
      try {
        const p = JSON.parse(payload) as { run_id: number; kind: string; id: number };
        ev = { runId: p.run_id, kind: p.kind, id: p.id };
      } catch {
        return; // ignore malformed payloads
      }
      const set = subscribers.get(ev.runId);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(ev);
        } catch {
          // a subscriber throwing must not break fan-out to the others
        }
      }
    });
  })();
  return globalThis.__runStreamListen;
}

/**
 * Subscribe to run_stream notifications for a single run. The callback fires
 * (best-effort, coalescible) whenever a new agent_event/agent_message is
 * inserted for `runId`. Returns an unsubscribe fn. Awaiting ensures the LISTEN
 * connection is established before the first notification can be missed.
 */
export async function subscribeRunStream(runId: number, cb: Callback): Promise<() => void> {
  await ensureListening();
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(cb);
  return () => {
    const s = subscribers.get(runId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subscribers.delete(runId);
  };
}
