/** Plan work stays in the executor's worker, including harness sub-agents. */
export function isPlanExecutor(run: { goal?: string | null; personaId?: string | null } | null | undefined): boolean {
  return run?.goal === "<execute>" || run?.personaId === "executor";
}

export const PLAN_EXECUTOR_TOOLS_PROFILE = "orchestrator,repo_write,gh_pr,gh_ci";

/** Also upgrades retained runs that still carry the old coordinator profile. */
export function effectiveRunToolsProfile(
  run: { goal?: string | null; personaId?: string | null; toolsProfile?: string | null; runtime?: string | null },
  fallback = ""
): string {
  // Never expand a legacy in-process persona's tools to shell/repository
  // capabilities. New executor runs are worker-only at create admission.
  return isPlanExecutor(run) && run.runtime !== "server"
    ? PLAN_EXECUTOR_TOOLS_PROFILE : run.toolsProfile || fallback;
}

export const EXECUTOR_CHILD_RUN_ERROR =
  "Plan executors cannot create or start child runs. Use the harness's native sub-agents " +
  "inside this same run, or implement sequentially inline if the harness has none. " +
  "Keep one sub-agent active by default and serialize memory-heavy checks.";

/** Codex resumes keep their original system preamble, so repeat the compact
 * runtime contract in the turn input too. Do not replay the whole persona. */
export function planExecutorTurnPrompt(
  run: { goal?: string | null; personaId?: string | null; runtime?: string | null },
  prompt: string
): string {
  if (!isPlanExecutor(run) || run.runtime === "server") return prompt;
  return `Current plan executor policy, overriding older coordination-only instructions:
Implement inside this same run and worker using native harness sub-agents (or
sequentially inline if unavailable). Repository and coding tools are enabled.
Never call start_session or spawn__spawn_agent or create replacement runs.
Use one active sub-agent by default, no nested delegation; allow at most two
only for disjoint work with measured memory headroom. Serialize heavy checks
under one owner with bounded test workers, await background commands and drain
work on memory pressure. Use task worktrees within this worker without switching
the parent's branch. You own task state, verified PR delivery and report_result;
sub-agents return through harness tools and must not end or park this run.
Respect existing CI repair owners. Report failing task PRs as blockers rather
than creating fixer runs. Refresh task state and notes; do not duplicate work.

${prompt}`;
}
