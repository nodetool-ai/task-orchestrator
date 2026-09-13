// lib/delegation-guidance.ts
//
// WHEN IS A NEW RUN WORTH IT? — one decision rule, injected into every run's
// system prompt (lib/extensions/delegation.ts, mounted by
// profiles.alwaysOnExtensions so it reaches the legacy in-process path, the
// postgres turn loop and the ws worker path alike).
//
// The orchestrator hands out two very differently priced ways to delegate:
//
//   1. A CHILD RUN (start_session / spawn__spawn_agent). A whole run row, a
//      container or Sprite, a checkout on the task branch, its own budget,
//      its own supervision/event plumbing, and a place in the depth+cost caps
//      of lib/extensions/spawn.ts. Seconds-to-minutes of provisioning before
//      the first token.
//   2. A NATIVE SUB-AGENT of the agent runtime itself. Same run, same
//      container, same checkout, no dispatch — it answers inline and its
//      context dies with the answer instead of costing a supervision chain.
//
// An agent that reaches for (1) when (2) would do burns a container to answer a
// question it could have answered where it already stands.
//
// (2) is HARNESS-SPECIFIC and does not exist everywhere, so the guidance is
// generated per run rather than written once (see lib/subagent-tools.ts for the
// name table): the Claude backend gets `Agent` with its real call shape, the
// Codex backend gets `spawn_agent` with its own, and pi — whose built-ins stop
// at read/write/edit/bash/grep/find/ls — is told plainly that it has none, so
// it does bounded sub-work inline instead of being sent after a tool that is
// not there. Runs with no native tool surface at all (the coordination-only
// executor, the server-runtime personas) get the child-run economy rule alone.

import { config } from "./config";
import { isServerRuntimeRun } from "./run-runtime";
import {
  SUBAGENT_ARG_KEYS,
  hasNativeSubagents,
  subagentToolName,
  type SubagentBackend,
} from "./subagent-tools";

/** The cost rule itself. True on every harness, so every flavour opens with it. */
export const CHILD_RUN_ECONOMY_RULE = `
Delegation guidance:
- A child run (start_session / spawn__spawn_agent) is a whole container, checkout, budget and supervision chain. Start one per unit of work that owns its own branch and PR — one child run per task, never one per step.
- Do NOT start a run for sub-work inside the job you already hold: searching the codebase, reading an unfamiliar area, reproducing a failure, reviewing your own diff, digesting long output. That is delegation you can do where you stand, and a run is the expensive way to do it.
- Start a child run only when the work genuinely needs its own run: a DIFFERENT task with its own branch, acceptance criteria and PR; a tool surface or persona you do not have; or work that must outlive your turn under its own supervision.
- Before starting one, check state: a task that already has an active run does not need a second one — resume it, or send it the context it is missing.
- Agents sharing a checkout also share its process and memory budget. Assign full-repository typecheck/build/test execution to one owner, run those checks sequentially with bounded test workers, and let reviewers reuse the results. Use focused checks for independent sub-work. A background command still consumes the shared budget; await it and clean it up before starting another heavy check.`;

/** Claude Agent SDK: `Agent`, with `Task` as the legacy wire name. */
export const CLAUDE_SUBAGENT_GUIDANCE = `
- Your harness (Claude Agent SDK) spawns sub-agents natively with the Agent tool: Agent(subagent_type, description, prompt). It runs in this container on this checkout and reports back inline. Older transcripts may show the same tool as Task — that is the legacy name for it, not a different mechanism, and not the TaskCreate/TaskGet/TaskUpdate/TaskList work-item tools.
- Use it for bounded, independent sub-work worth its own context: a search across unfamiliar code, a focused investigation, a review pass over your own diff. Give it the question and the paths to look at — it starts with none of your conversation.
- Prefer one sub-agent with a precise question over several speculative ones, and do not spawn one for work that is a single tool call for you.`;

/** Codex: `spawn_agent`, plus the rest of the multi-agent family. */
export const CODEX_SUBAGENT_GUIDANCE = `
- Your harness (Codex) spawns sub-agents natively with the spawn_agent tool: spawn_agent(task_name, message). A spawned agent gets its own task, runs independently, and may spawn further sub-agents; send_message, followup_task, wait_agent, list_agents and close_agent manage the ones you started. Older runtimes namespaced the same call as multi_agent_v1.spawn_agent.
- Use spawn_agent for substantial independent work that can execute in parallel, one call per independent task, and keep doing useful non-overlapping work while it runs. Do not spawn an agent for trivial work you could finish in a tool call or two.
- Wait on a sub-agent only when you actually need its result to continue, and close the ones you are done with.`;

/** pi: no sub-agent built-in, and no extension mounted that adds one. */
export const NO_NATIVE_SUBAGENT_GUIDANCE = `
- Your harness has no native sub-agent tool (pi's built-ins are read, write, edit, bash, grep, find and ls). So sub-work inside your job is yours to do here, directly and with bounded commands — not a reason to reach for a child run, which is the expensive substitute for a tool you are simply not given.`;

/** For runs with no native tool surface at all — the coordination-only
 *  executor, the server-runtime personas. There is nothing to prefer, so the
 *  rule is only about not multiplying runs. */
export const COORDINATOR_DELEGATION_GUIDANCE = `
- You hold no repository, shell or sub-agent tools, by design. Sub-work inside a task belongs to the run that owns that task, which does its own searching, reading and reviewing there. If a child lacks context, send it the context; do not start a second run beside it.
- Investigation, summarizing and status reporting are yours to do from task/run state and the events you were sent, not reasons to mint a run.`;

/** The columns the choice reads. Structural so a RunRow, a `db.select()`
 *  projection, and the ws worker's run snapshot all satisfy it. */
export interface DelegationRun {
  id: number;
  runtime: string;
  toolsProfile: string | null;
  personaId: string | null;
  /** The run's backend id; null inherits the deployment default. */
  backend?: string | null;
}

/**
 * Personas whose native tool surface is deliberately withheld, so they have no
 * harness sub-agent to prefer. Keep in step with the `nativeToolPolicy:
 * 'orchestration-only'` decision in lib/runs.ts: the executor coordinates
 * through orchestrator/spawn tools only (run 248 used the native tools as an
 * escape hatch around the CI repair budget), and the sub-agent tool is blocked
 * with them — a sub-agent inherits the surface its parent was denied.
 */
const ORCHESTRATION_ONLY_PERSONAS = new Set(["executor"]);

/** Tolerant backend resolution: an unknown or absent id behaves like the
 *  deployment default rather than throwing inside prompt assembly. */
export function resolveSubagentBackend(raw: string | null | undefined): SubagentBackend {
  const id = (raw ?? config.agent.backend ?? "pi").trim().toLowerCase();
  return id === "claude" || id === "codex" ? id : "pi";
}

/**
 * Does this run carry a native tool surface at all?
 *
 * Two ways to not: the persona is coordination-only (native tools, the
 * sub-agent tool included, are blocked for it), or the run executes in the
 * orchestrator process — the postgres turn loop mounts extension tools only.
 * Whether that surface actually INCLUDES a sub-agent tool is a separate
 * question, answered by the backend (see hasHarnessSubagents).
 */
export function hasNativeToolSurface(run: DelegationRun): boolean {
  if (run.personaId != null && ORCHESTRATION_ONLY_PERSONAS.has(run.personaId)) return false;
  return !isServerRuntimeRun(run);
}

/** Does this run have a native sub-agent tool it could actually call? Requires
 *  both a native tool surface and a harness that ships one (pi does not). */
export function hasHarnessSubagents(run: DelegationRun): boolean {
  if (!hasNativeToolSurface(run)) return false;
  return hasNativeSubagents(resolveSubagentBackend(run.backend));
}

/** The harness-specific half of the guidance for `backend`. */
export function subagentGuidanceFor(backend: SubagentBackend): string {
  if (backend === "claude") return CLAUDE_SUBAGENT_GUIDANCE;
  if (backend === "codex") return CODEX_SUBAGENT_GUIDANCE;
  return NO_NATIVE_SUBAGENT_GUIDANCE;
}

/** The delegation text this run should be told, based on what it can actually
 *  reach: the cost rule always, then either its harness's sub-agent tool or the
 *  reason it has none. */
export function delegationGuidanceFor(run: DelegationRun): string {
  const tail = hasNativeToolSurface(run)
    ? subagentGuidanceFor(resolveSubagentBackend(run.backend))
    : COORDINATOR_DELEGATION_GUIDANCE;
  return `${CHILD_RUN_ECONOMY_RULE.trimEnd()}\n${tail.trim()}`;
}

/**
 * The one-line form carried by the descriptions of the tools that MINT a run
 * (start_session, spawn__spawn_agent). The system prompt can be edited away by
 * a persona author; a tool description travels with the tool on every path, so
 * the cost of the button is stated on the button itself. It names both harness
 * tools because the registry is shared across backends — the per-run prompt is
 * where the caller learns which one it actually has.
 */
export const RUN_MINTING_COST_NOTE =
  "Cost: a child run is a fresh container, checkout, budget and supervision chain. " +
  "One run per task, not per step — for sub-work inside the job you already hold " +
  "(searching, reading, reproducing, reviewing, digesting output) use your harness's own " +
  `sub-agent tool where it has one (Claude Agent SDK: ${subagentToolName("claude")}(${SUBAGENT_ARG_KEYS.claude?.agentType}, ${SUBAGENT_ARG_KEYS.claude?.instruction}); ` +
  `Codex: ${subagentToolName("codex")}(${SUBAGENT_ARG_KEYS.codex?.label}, ${SUBAGENT_ARG_KEYS.codex?.instruction})), ` +
  "which shares this checkout and needs no provisioning, and otherwise do the sub-work inline. " +
  "A task that already has an active run does not need a second one.";
