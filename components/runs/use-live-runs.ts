"use client";

// Live run rows for every surface that renders the run list (/runs and the
// home page), so both stay in sync from one subscription.
//
// Primary path is a push-based EventSource on /api/runs/overview/events: the
// server sends `{ type:"rows", rows }` frames on every change (debounced),
// re-rendered with zero client polling. If the stream errors we fall back to a
// 6s poll of /api/runs/overview, retrying the stream periodically. While the
// tab is hidden both the stream and the poll are suspended, and we
// reconnect/refresh immediately on becoming visible. `offline` means "can't
// refresh": it goes true only when the FALLBACK poll itself fails (a healthy
// stream, or a stream error with a working poll, keeps us online).

import * as React from "react";

import type { RunIndexRow } from "@/lib/run-index";

const POLL_MS = 6000;
// While in poll-fallback mode (stream errored), periodically try to re-open the
// SSE stream so a transient network blip doesn't strand us on polling forever.
const STREAM_RETRY_MS = 45_000;

export function useLiveRuns(initialRows: RunIndexRow[]): {
  rows: RunIndexRow[];
  offline: boolean;
} {
  const [rows, setRows] = React.useState(initialRows);
  const [offline, setOffline] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // `true` once the stream has errored: we stay on polling and periodically
    // try to re-establish the stream.
    let usePoll = false;

    // ── Poll fallback (the original 6s loop) ──────────────────────────────
    async function pollTick() {
      if (cancelled) return;
      if (!document.hidden) {
        try {
          const res = await fetch("/api/runs/overview", { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as { rows: RunIndexRow[] };
          if (cancelled) return;
          setRows(data.rows);
          setOffline(false);
        } catch {
          if (cancelled) return;
          setOffline(true);
        }
      }
      if (!cancelled && usePoll) pollTimer = setTimeout(pollTick, POLL_MS);
    }

    function startPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      // Refresh immediately so the fallback doesn't wait out a full interval.
      void pollTick();
    }

    function stopPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    }

    // ── SSE primary path ──────────────────────────────────────────────────
    function fallBackToPolling() {
      usePoll = true;
      closeStream();
      startPolling();
      // Keep trying to climb back onto the stream.
      if (!retryTimer) {
        retryTimer = setTimeout(function retry() {
          retryTimer = null;
          if (cancelled || document.hidden) return;
          usePoll = false;
          stopPolling();
          openStream();
        }, STREAM_RETRY_MS);
      }
    }

    function closeStream() {
      if (es) {
        es.close();
        es = null;
      }
    }

    function openStream() {
      if (cancelled || document.hidden) return;
      closeStream();
      const source = new EventSource("/api/runs/overview/events");
      es = source;
      source.onmessage = (e) => {
        if (cancelled) return;
        let msg: { type: string; rows?: RunIndexRow[] };
        try {
          msg = JSON.parse(e.data) as { type: string; rows?: RunIndexRow[] };
        } catch {
          return;
        }
        if (msg.type === "rows" && msg.rows) {
          setRows(msg.rows);
          setOffline(false);
        } else if (msg.type === "_eos") {
          // Server closed deliberately (e.g. unauthenticated). EventSource
          // would otherwise auto-reconnect forever, so drop to polling.
          fallBackToPolling();
        }
      };
      source.onerror = () => {
        // Transient network error or server hiccup: EventSource retries on its
        // own, but to preserve refresh coverage we switch to polling and retry
        // the stream on our own cadence.
        if (cancelled) return;
        fallBackToPolling();
      };
    }

    // ── Visibility: suspend everything while hidden ───────────────────────
    function suspend() {
      closeStream();
      stopPolling();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    }

    function resume() {
      if (cancelled) return;
      // Coming back to the tab always re-attempts the primary (stream) path;
      // if it errors again onerror drops us back to polling. This also avoids
      // getting stranded on polling when a stream-retry fired while hidden.
      usePoll = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      openStream();
    }

    const onVisible = () => {
      if (document.hidden) suspend();
      else resume();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Kick off on the primary (stream) path.
    openStream();

    return () => {
      cancelled = true;
      closeStream();
      stopPolling();
      if (retryTimer) clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { rows, offline };
}
