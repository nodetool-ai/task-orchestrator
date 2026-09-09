// lib/worker/server-tools.ts
//
// The unified server-side tool registry behind RunTransport.callTool.
//
// Workers never touch Postgres (hard requirement): every tool an agent can
// invoke that reads or writes orchestrator state executes HERE, on the
// orchestrator, keyed by name. That covers:
//   • the 37 orchestrator tools (lib/orchestrator-tools),
//   • the always-on event tools (lib/extensions/events EVENT_TOOLS),
//   • the planning gate tools (lib/extensions/planning PLANNING_TOOLS),
//   • the child-spawn tools (lib/extensions/spawn SPAWN_TOOLS),
//   • the persona-memory tools (lib/extensions/persona-memory MEMORY_TOOLS),
//   • the model-welfare tools (lib/extensions/model-welfare WELFARE_TOOLS).
//
// The extension factories register thin wrappers that call
// transport.callTool(runId, name, params, ctx); in the web-server process the
// db transport resolves the tool through this registry and runs it in-process,
// and for a dispatched worker the channel's tool.invoke command lands here on
// the control plane. Tool name collisions across registries are a programmer
// error — names are namespaced by convention (timer__*, events__*, spawn__*,
// memory_*, planning's verbs) and asserted in tests.
//
// All imports are lazy: each registry module pulls in repo/runs/inbox, and
// this module is reachable from lib/runs.ts via the transport.

import type { OrchestratorTool } from "../orchestrator-tools";
import { dispatchTool } from "../app-api/dispatcher";
import type { AppApiContext, AppApiResult } from "../app-api/types";
import { Type } from "typebox";
import { codeActCatalog, executeCodeAct } from "../codeact";
import { PostgresCodeActReceiptStore } from "../codeact/receipts";

const codeActTools: OrchestratorTool[] = [
  {
    name: "codeact_catalog", label: "CodeAct Catalog",
    description: "Discover the bounded, authorized CodeAct application operation catalogue.",
    parameters: Type.Object({ query: Type.Optional(Type.String()), names: Type.Optional(Type.Array(Type.String())) }),
    execute: async (params: { query?: string; names?: string[] }, ctx) => {
      const catalog = codeActCatalog((ctx as AppApiContext).capabilities);
      const operations = params.names?.length ? catalog.operations.filter((x) => params.names!.includes(x.name) || params.names!.includes(x.sdkPath)) : params.query ? catalog.operations.filter((x) => JSON.stringify(x).toLowerCase().includes(params.query!.toLowerCase())).slice(0, 20) : catalog.operations;
      return { content: [{ type: "text", text: JSON.stringify({ ...catalog, operations }) }] };
    },
  },
  {
    name: "codeact_execute", label: "CodeAct Execute",
    description: "Execute source in the isolated QuickJS-NG CodeAct runtime.",
    parameters: Type.Object({ code: Type.String(), title: Type.Optional(Type.String()) }),
    execute: async (params: { code: string; title?: string }, ctx) => {
      const context = ctx as AppApiContext;
      const result = await executeCodeAct({ code: params.code, title: params.title, context, receipts: context.runId ? new PostgresCodeActReceiptStore(context.runId) : undefined });
      return { content: [{ type: "text", text: JSON.stringify({ executionId: result.executionId, status: result.receipt.status, result: "value" in result ? result.value : undefined, outputs: result.receipt.outputs, diagnostics: result.receipt.diagnostics }) }] };
    },
  },
];

export type { OrchestratorTool };

let registryPromise: Promise<Map<string, OrchestratorTool>> | null = null;

async function buildRegistry(): Promise<Map<string, OrchestratorTool>> {
  const [orch, events, planning, spawn, memory, welfare, terminalPr] = await Promise.all([
    import("../orchestrator-tools"),
    import("../extensions/events"),
    import("../extensions/planning"),
    import("../extensions/spawn"),
    import("../extensions/persona-memory"),
    import("../extensions/model-welfare"),
    import("../worker-terminal-pr"),
  ]);
  const all: OrchestratorTool[] = [
    ...codeActTools,
    ...orch.ORCHESTRATOR_TOOLS,
    ...events.EVENT_TOOLS,
    ...planning.PLANNING_TOOLS,
    ...spawn.SPAWN_TOOLS,
    ...memory.MEMORY_TOOLS,
    ...welfare.WELFARE_TOOLS,
    ...terminalPr.WORKER_TERMINAL_PR_TOOLS,
  ];
  const map = new Map<string, OrchestratorTool>();
  for (const tool of all) {
    if (map.has(tool.name)) {
      // Fail loudly at first use — a silent shadow would route an agent's call
      // to the wrong implementation.
      throw new Error(`Duplicate server tool name: ${tool.name}`);
    }
    map.set(tool.name, tool);
  }
  return map;
}

/** Look up a server-executable tool by bare name (no task_orch__ prefix). */
export async function resolveServerTool(name: string): Promise<OrchestratorTool | null> {
  if (!registryPromise) registryPromise = buildRegistry();
  return (await registryPromise).get(name) ?? null;
}

/** Execute any server tool through the same descriptor/policy boundary used by
 * MCP and SDK callers. The registry remains the implementation catalogue; the
 * dispatcher is the authorization and validation boundary. */
export async function executeServerTool(
  tool: OrchestratorTool,
  params: unknown,
  ctx: AppApiContext,
): Promise<AppApiResult> {
  return dispatchTool(tool, params, ctx);
}
