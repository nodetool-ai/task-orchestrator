// lib/extensions/abort-bridge.ts
//
// Wire an external AbortController to pi's per-session ctx.abort(). The
// runner constructs an AbortController per turn; when something upstream
// (CLI ^C, UI cancel, budget timeout) aborts it, we want pi's agent loop
// to stop. Listen on agent_start because that's when ctx becomes available.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "./types";

export const abortBridgeFactory =
  (abort: AbortController): ExtensionFactory =>
  (pi: ExtensionAPI) => {
    pi.on("agent_start", (_event: any, ctx: any) => {
      const onAbort = () => { try { ctx.abort(); } catch { /* swallow */ } };
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
