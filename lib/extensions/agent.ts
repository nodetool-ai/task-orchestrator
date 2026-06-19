// lib/extensions/agent.ts
//
// Thin adapter: iterates the shared orchestrator tool registry and registers
// each tool under the task_orch__ prefix. All tool logic lives in
// lib/orchestrator-tools.ts so a parallel MCP server can consume the same
// definitions.

import type { ExtensionFactory } from "./types";
import { ORCHESTRATOR_TOOLS } from "@/lib/orchestrator-tools";

export interface OrchestratorExtensionOptions {
  author: string;
  defaultTaskId?: string;
  defaultPlanId?: string;
  /** The run these tools execute inside; passed to spawned children as parent. */
  runId?: number;
}

export const orchestratorExtension =
  (opts: OrchestratorExtensionOptions): ExtensionFactory =>
  (reg) => {
    for (const tool of ORCHESTRATOR_TOOLS) {
      reg.registerTool({
        name: `task_orch__${tool.name}`,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_id, params) => {
          const r = await tool.execute(params, {
            author: opts.author,
            defaultTaskId: opts.defaultTaskId,
            defaultPlanId: opts.defaultPlanId,
            runId: opts.runId,
          });
          return {
            content: r.content,
            details: undefined,
            isError: r.isError ?? false,
          };
        },
      });
    }
  };
