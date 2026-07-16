// lib/extensions/agent.ts
//
// Thin adapter: iterates the shared orchestrator tool registry and registers
// each tool under the task_orch__ prefix. All tool logic lives in
// lib/orchestrator-tools.ts so a parallel MCP server can consume the same
// definitions.
//
// Execution routes through the worker RunTransport: in-process against the DB
// normally, or proxied to the orchestrator's POST /api/worker/runs/:id/tools/call
// when this process is an HTTP-mode worker — the tool then runs server-side,
// so external workers expose the full tool surface with no database access.

import type { ExtensionFactory, ToolInvoker } from "./types";
import { ORCHESTRATOR_TOOLS } from "@/lib/orchestrator-tools";
import { legacyToolInvoker } from "./legacy-invoker";

export interface OrchestratorExtensionOptions {
  author: string;
  defaultTaskId?: string;
  defaultPlanId?: string;
  /** The run these tools execute inside; passed to spawned children as parent. */
  runId?: number;
  /** Tool execution seam (plan section 15). Supplied by the ws worker path
   *  (`session.invokeTool`); defaults to the legacy transport-backed invoker. */
  invoke?: ToolInvoker;
}

export const orchestratorExtension =
  (opts: OrchestratorExtensionOptions): ExtensionFactory =>
  (reg) => {
    const invoke =
      opts.invoke ??
      legacyToolInvoker(opts.runId, {
        author: opts.author,
        defaultTaskId: opts.defaultTaskId,
        defaultPlanId: opts.defaultPlanId,
      });
    for (const tool of ORCHESTRATOR_TOOLS) {
      reg.registerTool({
        name: `task_orch__${tool.name}`,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_id, params) => {
          const r = await invoke(tool.name, params);
          return {
            content: r.content,
            details: undefined,
            isError: r.isError ?? false,
          };
        },
      });
    }
  };
