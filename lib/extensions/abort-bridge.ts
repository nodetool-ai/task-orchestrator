// lib/extensions/abort-bridge.ts
//
// Wire an external AbortController to the backend's per-turn abort. The runner
// constructs an AbortController per turn; when something upstream (CLI ^C, UI
// cancel, budget timeout) aborts it, we want the agent loop to stop. The
// backend invokes onAgentStart once the loop is live, handing us an abort()
// callback (pi: ctx.abort(); Claude: the query AbortController).

import type { ExtensionFactory } from "./types";

export const abortBridgeFactory =
  (abort: AbortController): ExtensionFactory =>
  (reg) => {
    reg.onAgentStart((ctx) => {
      const onAbort = () => { try { ctx.abort(); } catch { /* swallow */ } };
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
