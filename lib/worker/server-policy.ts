// Control-plane catalogue policy shared by run.start snapshots and in-process
// (postgres-context) turns. Keeping this list in one server-only module makes
// the worker's persisted policy and CodeAct's per-subcall policy identical.

const CODEACT_TOOLS = ["codeact_catalog", "codeact_execute"] as const;

export async function allowedServerTools(profile: string): Promise<string[]> {
  const names = new Set<string>(CODEACT_TOOLS);
  const [events, memory, orchestrator, planning, spawn] = await Promise.all([
    import("../extensions/events"),
    import("../extensions/persona-memory"),
    import("../orchestrator-tools"),
    import("../extensions/planning"),
    import("../extensions/spawn"),
  ]);

  // Event/lifecycle tools and the agent-facing memory operations are mounted
  // for every run. memory__load remains an internal prompt-composition call.
  for (const tool of [...events.EVENT_TOOLS, ...memory.MEMORY_TOOLS]) {
    if (tool.name !== "memory__load") names.add(tool.name);
  }

  // The worker driver invokes this after pushing an implementation branch. It
  // is channel-authorized but intentionally never registered to the model.
  names.add("worker__open_terminal_pr");

  const profiles = new Set(
    profile.split(",").map((value) => value.trim()).filter(Boolean),
  );
  if (profiles.has("orchestrator")) {
    for (const tool of orchestrator.ORCHESTRATOR_TOOLS) names.add(tool.name);
  }
  if (profiles.has("planning")) {
    for (const tool of planning.PLANNING_TOOLS) names.add(tool.name);
  }
  if (profiles.has("spawn")) {
    for (const tool of spawn.SPAWN_TOOLS) names.add(tool.name);
  }
  return [...names].sort();
}

/** Translate the persisted bare-tool policy into the explicit per-operation
 * grants consumed by the application dispatcher. */
export function appCapabilitiesForTools(tools: readonly string[]): string[] {
  return tools
    .map((name) => `app:${name.replace(/^task_orch__/, "")}`);
}
