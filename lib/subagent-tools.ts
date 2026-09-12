// lib/subagent-tools.ts
//
// WHICH NATIVE TOOL SPAWNS A SUB-AGENT, PER HARNESS.
//
// Sub-agent spawning is a capability of the agent runtime, not something this
// orchestrator reimplements: a harness that has one runs the sub-agent in the
// turn's own process, on the same checkout, and hands the answer back inline.
// The three harnesses this deployment drives (lib/agent-backend) name that
// capability differently, and two of them have renamed it at least once — so
// the names live here, in one table, instead of being spelled out wherever a
// prompt, an interceptor or a containment list needs them.
//
//   NodeTool concept   Codex                     Claude            pi
//   ────────────────────────────────────────────────────────────────────────
//   spawn sub-agent    spawn_agent               Agent             (none)
//   agent type         —                         subagent_type     —
//   label              task_name                 description       —
//   instruction        message                   prompt            —
//   legacy spawn name  multi_agent_v1.spawn_agent  Task            —
//
// Claude: `Agent` is the current Claude Agent SDK wire name. `Task` is what the
// 0.2.x releases emitted — the SDK changelog records an `Agent` rename that was
// temporarily reverted to `Task` and then landed in 0.3.x. DETECT both; GENERATE
// `Agent`. `Task` here is that legacy sub-agent tool and has nothing to do with
// the harness's TaskCreate/TaskGet/TaskUpdate/TaskList work-item tools.
//
// Codex: multi-agent v2 exposes `spawn_agent` as a top-level function tool (v1
// namespaced it as `multi_agent_v1.spawn_agent`). A spawned agent gets its own
// task and may spawn further sub-agents; the rest of the family messages, waits
// on and closes them.
//
// pi: its built-ins are read / write / edit / bash / grep / find / ls and that
// is all (pi-coding-agent docs, "Built-in tool names"). Sub-agents exist only as
// an optional extension that registers its own tool, which this deployment does
// not mount — so a pi run has NO native sub-agent, and must not be told to use
// one.

/** The agent runtimes this orchestrator drives (lib/agent-backend BackendId). */
export type SubagentBackend = "claude" | "codex" | "pi";

/** Claude Agent SDK: current wire name first, legacy second. */
export const CLAUDE_SUBAGENT_TOOLS = ["Agent", "Task"] as const;

/** Codex: the multi-agent v2 tool, then the v1-namespaced form. */
export const CODEX_SUBAGENT_TOOLS = ["spawn_agent", "multi_agent_v1.spawn_agent"] as const;

/** The whole Codex multi-agent surface — spawning plus the tools that talk to,
 *  wait on, enumerate and close what was spawned. Codex's SDK exposes no
 *  native-tool allowlist, so this is for detection and normalization, not for
 *  containment (the Codex backend contains an orchestration-only run with a
 *  read-only sandbox and no network instead). */
export const CODEX_MULTI_AGENT_TOOLS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "close_agent",
] as const;

/** pi ships no sub-agent built-in. */
export const PI_SUBAGENT_TOOLS = [] as const;

const BY_BACKEND: Record<SubagentBackend, readonly string[]> = {
  claude: CLAUDE_SUBAGENT_TOOLS,
  codex: CODEX_SUBAGENT_TOOLS,
  pi: PI_SUBAGENT_TOOLS,
};

/** Every native tool name that spawns a sub-agent on `backend`, current name
 *  first. Empty when the harness has none. */
export function subagentToolsFor(backend: SubagentBackend): readonly string[] {
  return BY_BACKEND[backend] ?? PI_SUBAGENT_TOOLS;
}

/** The name to GENERATE for `backend` (prompts, generated code), or null when
 *  the harness has no sub-agent tool. */
export function subagentToolName(backend: SubagentBackend): string | null {
  return subagentToolsFor(backend)[0] ?? null;
}

/** Does this harness spawn sub-agents natively at all? */
export function hasNativeSubagents(backend: SubagentBackend): boolean {
  return subagentToolsFor(backend).length > 0;
}

/** Is `toolName` this backend's sub-agent spawn tool — current name or legacy?
 *  Case-insensitive, so a harness that re-cases a name still matches. */
export function isSubagentTool(backend: SubagentBackend, toolName: string): boolean {
  const needle = toolName.trim().toLowerCase();
  return subagentToolsFor(backend).some((name) => name.toLowerCase() === needle);
}

/** Which argument carries which concept in a spawn call, per harness. Null for
 *  a harness with no sub-agent tool. */
export const SUBAGENT_ARG_KEYS: Record<
  SubagentBackend,
  { label: string; instruction: string; agentType: string | null } | null
> = {
  claude: { label: "description", instruction: "prompt", agentType: "subagent_type" },
  codex: { label: "task_name", instruction: "message", agentType: null },
  pi: null,
};
