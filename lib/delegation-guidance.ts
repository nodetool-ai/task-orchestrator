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
//   2. A HARNESS SUBAGENT (Claude's `Task`, pi's `task`). Same run, same
//      container, same checkout, no dispatch — it answers inline and its
//      context dies with the answer instead of costing a supervision chain.
//
// An agent that reaches for (1) when (2) would do burns a container to answer a
// question it could have answered where it already stands. The guidance below
// says so, in the two forms the fleet actually needs: agents that HAVE harness
// subagents get the "use them" rule; agents that do not (the coordination-only
// executor, the server-runtime concierge — no native tool surface at all) get
// the "one child run per task, not per step" rule instead, because telling them
// to use a tool they were never given is worse than saying nothing.

import { isServerRuntimeRun } from "./run-runtime";

/** For runs that carry the backend's native tool surface: prefer the in-run
 *  subagent over minting another run. */
export const IN_RUN_DELEGATION_GUIDANCE = `
Delegation guidance (prefer subagents over new runs):
- Sub-work inside the job you already hold — searching the codebase, reading an unfamiliar area, reproducing a failure, drafting a review of your own diff, digesting long output — belongs to your harness's own subagent tool (Task on the Claude harness, task on pi). It runs in this container, on this checkout, returns its answer inline, and costs no provisioning.
- Do NOT start or spawn another RUN for work you can do here. A child run is a fresh container, checkout, budget and supervision chain; spending one on a step of the task you are already on is waste, not delegation.
- Start a child run only when the work genuinely needs its own run: a DIFFERENT task with its own branch, acceptance criteria and PR; a tool surface or persona you do not have; or work that must outlive your turn under its own supervision. When in doubt, do it here.
- Before starting one anyway, check state: a task that already has an active run does not need a second one — resume or message the existing run instead.
- Subagents are not free either. Prefer one subagent with a precise question over several speculative ones, and give it the question plus the paths to look at — it starts with none of your conversation.`;

/** For runs with no native tool surface (coordination-only executor,
 *  server-runtime personas): there is no subagent to prefer, so the rule is
 *  about not multiplying runs. */
export const CHILD_RUN_ECONOMY_GUIDANCE = `
Delegation guidance (one child run per task, not per step):
- A child run is a whole container, checkout, budget and supervision chain. Start one per unit of work that owns its own branch and PR — never for a step inside a task another run already owns, and never as a way to ask a question.
- Sub-work inside a task belongs to the run that owns that task: it has its own harness subagents for searching, reading and reviewing. If a child lacks context, send it the context; do not start a second run beside it.
- Before starting a run, read task state: a task with an active run does not need another one — resume it, or message it.
- Investigation, summarizing, and status reporting are yours to do from task/run state and the events you were sent, not reasons to mint a run.`;

/** The columns the choice reads. Structural so a RunRow, a `db.select()`
 *  projection, and the ws worker's run snapshot all satisfy it. */
export interface DelegationRun {
  id: number;
  runtime: string;
  toolsProfile: string | null;
  personaId: string | null;
}

/**
 * Personas whose native tool surface is deliberately withheld, so they have no
 * harness subagent to prefer. Keep in step with the `nativeToolPolicy:
 * 'orchestration-only'` decision in lib/runs.ts: the executor coordinates
 * through orchestrator/spawn tools only (run 248 used the native tools as an
 * escape hatch around the CI repair budget), and `Task` is blocked with them.
 */
const ORCHESTRATION_ONLY_PERSONAS = new Set(["executor"]);

/**
 * Does this run have the harness's own subagent tool?
 *
 * Two ways to not have one: the persona is coordination-only (native tools,
 * `Task`/`task` included, are blocked for it), or the run executes in the
 * orchestrator process — the postgres turn loop mounts extension tools only,
 * no native tool surface at all.
 */
export function hasHarnessSubagents(run: DelegationRun): boolean {
  if (run.personaId != null && ORCHESTRATION_ONLY_PERSONAS.has(run.personaId)) return false;
  return !isServerRuntimeRun(run);
}

/** The delegation fragment this run should be told, based on what it can
 *  actually reach. */
export function delegationGuidanceFor(run: DelegationRun): string {
  return hasHarnessSubagents(run) ? IN_RUN_DELEGATION_GUIDANCE : CHILD_RUN_ECONOMY_GUIDANCE;
}

/**
 * The one-line form carried by the descriptions of the tools that MINT a run
 * (start_session, spawn__spawn_agent). The system prompt can be edited away by
 * a persona author; a tool description travels with the tool on every path, so
 * the cost of the button is stated on the button itself.
 */
export const RUN_MINTING_COST_NOTE =
  "Cost: a child run is a fresh container, checkout, budget and supervision chain. " +
  "One run per task, not per step — for sub-work inside the job you already hold " +
  "(searching, reading, reproducing, reviewing, digesting output) use your harness's own " +
  "subagent tool (Task/task), which shares this checkout and needs no provisioning. " +
  "A task that already has an active run does not need a second one.";
