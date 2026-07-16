// lib/worker-runtime/tools.ts
//
// Worker-side tool bridge for the WebSocket transport (plan section 15).
//
// This module runs INSIDE the worker process and must never read Postgres or
// import the control-plane tool registries (which drag in the database) — the
// worker-runtime bundle guard forbids it. It knows only two things:
//   1. the authorized tool catalogue the control plane put in `run.start`
//      (`RunStart.policy.allowedTools`); and
//   2. the live `WorkerSession`, whose `invokeTool` sends a `tool.invoke` event
//      over the channel and awaits the control plane's `tool.result`.
//
// From those it produces a single {@link ToolInvoker} the extension seam and the
// backend consume. Every extension (agent/events/planning/spawn/persona-memory)
// takes a `ToolInvoker`; on the ws path this is the invoker they receive, so
// they never touch a transport or a session directly (the same seam the legacy
// in-process path fills with lib/extensions/legacy-invoker). Execution,
// authorization, scope derivation, and idempotency all happen control-plane-side
// (lib/worker-channel/tool-invoke.ts); this bridge only forwards the call and
// enforces the catalogue as defense in depth.

import { randomUUID } from "node:crypto";
import type { ToolInvoker } from "../extensions/types";
import type { RunStart, ToolCallResult } from "../worker-channel/protocol";

/** The narrow slice of {@link WorkerSession} the bridge needs. Structural so a
 *  test double or the live session both satisfy it. */
export interface ToolInvokingSession {
  invokeTool(tool: string, args: unknown, callId: string): Promise<ToolCallResult>;
}

/** The authorized tool names for a run, as pushed in `run.start`. */
export function authorizedToolNames(start: RunStart): ReadonlySet<string> {
  return new Set(start.policy.allowedTools);
}

function deniedResult(tool: string): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: `Tool '${tool}' is not available to this run (not in the authorized catalogue).`,
      },
    ],
    isError: true,
  };
}

/**
 * Build the worker-side {@link ToolInvoker}. It exposes ONLY the names in the
 * authorized catalogue: a call to any other name fails closed here without ever
 * reaching the channel (the control plane independently re-checks the persisted
 * start policy — this is the worker-local mirror of that gate). Every permitted
 * call is forwarded to `session.invokeTool` with a fresh channel call id.
 */
export function buildWorkerToolInvoker(
  start: RunStart,
  session: ToolInvokingSession
): ToolInvoker {
  const allowed = authorizedToolNames(start);
  return async (tool, params) => {
    if (!allowed.has(tool)) return deniedResult(tool);
    const result = await session.invokeTool(tool, params, randomUUID());
    return { content: result.content, isError: result.isError };
  };
}
