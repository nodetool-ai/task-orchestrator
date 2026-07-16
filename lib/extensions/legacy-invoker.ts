// lib/extensions/legacy-invoker.ts
//
// The legacy (in-process / HTTP-worker) construction of the extension tool
// seams (plan section 15). Extensions no longer reach for `runTransport`
// themselves — the caller supplies a {@link ToolInvoker}. On the WebSocket
// worker path lib/worker-runtime/tools.ts supplies a `session.invokeTool`-backed
// invoker; on the legacy path lib/profiles.ts and lib/runs.ts use the helpers
// below, which resolve the same server tool registry through the run transport.
//
// This module is the ONLY extension-layer importer of `@/lib/worker`; it is
// deleted together with the HTTP transport in plan section 18.

import { runTransport } from "@/lib/worker";
import type { ToolInvoker } from "./types";

export interface LegacyToolContext {
  author: string;
  defaultTaskId?: string;
  defaultPlanId?: string;
}

/** A {@link ToolInvoker} that runs tools through the run transport's server-tool
 *  registry, with the given scope baked in. */
export function legacyToolInvoker(runId: number | undefined, ctx: LegacyToolContext): ToolInvoker {
  return async (tool, params) => {
    const transport = await runTransport();
    const r = await transport.callTool(runId, tool, params, ctx);
    return { content: r.content, isError: r.isError ?? false };
  };
}

/** Resolve the deployment's registered repo remotes through the transport
 *  (the repo-remote lookup gh_pr/gh_ci gate PR urls on). */
export function legacyRepoRemotes(): () => Promise<
  Array<{ id: string; name: string; remote: string | null }>
> {
  return async () => (await runTransport()).listRepoRemotes();
}

/** Acquire the cross-run `pr:<url>` lease through the transport. */
export function legacyPrLock(): (
  runId: number,
  prUrl: string
) => Promise<{ ok: boolean; reason?: string }> {
  return (runId, prUrl) => runTransport().then((t) => t.acquirePrLock(runId, prUrl));
}
