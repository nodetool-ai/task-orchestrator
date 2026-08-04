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

export type { OrchestratorTool };

let registryPromise: Promise<Map<string, OrchestratorTool>> | null = null;

async function buildRegistry(): Promise<Map<string, OrchestratorTool>> {
  const [orch, events, planning, spawn, memory, welfare] = await Promise.all([
    import("../orchestrator-tools"),
    import("../extensions/events"),
    import("../extensions/planning"),
    import("../extensions/spawn"),
    import("../extensions/persona-memory"),
    import("../extensions/model-welfare"),
  ]);
  const all: OrchestratorTool[] = [
    ...orch.ORCHESTRATOR_TOOLS,
    ...events.EVENT_TOOLS,
    ...planning.PLANNING_TOOLS,
    ...spawn.SPAWN_TOOLS,
    ...memory.MEMORY_TOOLS,
    ...welfare.WELFARE_TOOLS,
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
