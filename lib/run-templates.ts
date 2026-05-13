// Run templates: prompt builders and default budgets for the various
// "kinds" of runs the UI can launch. The /api/runs POST surface is generic
// (it takes a CreateRunInput), but the UI exposes a small set of named
// templates that fill in the right tools_profile, cwd_strategy, budget,
// and initial prompt.
//
// The implement template is the one wired up to the task page button:
// kick off a worktree, run the agent against the task, open a PR.

import type { TaskFull } from "./types";
import * as repo from "./repo";

export const IMPLEMENT_DEFAULT_BUDGET_USD = 20;

/**
 * Build the implement-style agent prompt for a task: title, body,
 * acceptance criteria, parent-plan context, and operating instructions.
 *
 * This is the single source of truth — both the UI preview (modal) and
 * the runner (lib/runs.ts) call into here so what the user sees in the
 * modal is exactly what the agent receives.
 */
export function buildImplementPrompt(task: TaskFull): string {
  const lines: string[] = [];
  lines.push(`You are an autonomous coding agent working on task ${task.id}.`);
  lines.push("");
  lines.push(`# ${task.title}`);
  if (task.body.trim()) {
    lines.push("");
    lines.push("## Description");
    lines.push(task.body.trim());
  }
  if (task.criteria.length > 0) {
    lines.push("");
    lines.push("## Acceptance criteria");
    for (const c of task.criteria) lines.push(`- [${c.done ? "x" : " "}] ${c.text}`);
  }
  if (task.dependencies.length > 0) {
    lines.push("");
    lines.push("## Depends on (already done)");
    for (const dep of task.dependencies) lines.push(`- ${dep}`);
  }

  // Recent notes — the task page surfaces these inline; the agent should
  // see them too so it doesn't redo work the human already commented on.
  if (task.notes.length > 0) {
    const recent = task.notes.slice(-5);
    lines.push("");
    lines.push("## Recent notes");
    for (const n of recent) {
      lines.push(`- @${n.author}: ${n.body.trim().replace(/\n+/g, " ")}`);
    }
  }

  // Parent plan context: the broader goal this task belongs to, plus a
  // snapshot of sibling tasks so the agent knows what's already shipped
  // and what's still open. The agent can fetch more detail via
  // mcp__task_orch__get_plan / get_task; this is proactive lookahead.
  const plan = repo.getPlan(task.planId);
  if (plan) {
    lines.push("");
    lines.push(`# Parent plan: ${plan.id} — ${plan.title}`);
    lines.push(`(state: ${plan.state}${plan.owner ? `, owner: @${plan.owner}` : ""})`);
    if (plan.body.trim()) {
      lines.push("");
      lines.push("## Plan description");
      const body = plan.body.trim();
      const capped =
        body.length > 6000
          ? body.slice(0, 6000) +
            "\n\n…(truncated; call mcp__task_orch__get_plan for the full body)"
          : body;
      lines.push(capped);
    }
    const siblings = repo
      .listTasks({ planId: plan.id })
      .filter((t) => t.id !== task.id);
    if (siblings.length > 0) {
      lines.push("");
      lines.push("## Other tasks in this plan");
      const rank: Record<string, number> = {
        in_progress: 0,
        review: 1,
        todo: 2,
        blocked: 3,
        done: 4,
        cancelled: 5,
      };
      const sorted = [...siblings].sort(
        (a, b) =>
          (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.id.localeCompare(b.id)
      );
      const MAX = 25;
      for (const s of sorted.slice(0, MAX)) {
        const meta = [s.state, s.assignee ? `@${s.assignee}` : null]
          .filter(Boolean)
          .join(", ");
        lines.push(`- ${s.id} [${meta}] ${s.title}`);
      }
      if (sorted.length > MAX) {
        lines.push(
          `- … and ${sorted.length - MAX} more (use mcp__task_orch__list_tasks with plan_id=${plan.id} to see all)`
        );
      }
    }
  }

  lines.push("");
  lines.push("# Working environment");
  lines.push("- You are in an isolated git worktree on a fresh branch.");
  lines.push("- Make all changes here. Commit with a clear message.");
  lines.push("- Do NOT push and do NOT open a PR — the orchestrator does both after you finish.");
  lines.push("- Run typecheck and lint where it applies; fix any errors you introduce.");
  lines.push("- This is a non-interactive run. Make reasonable decisions; do not ask questions.");
  lines.push("");
  lines.push("# Task-system MCP tools");
  lines.push("- mcp__task_orch__add_note(body): log a decision so the next person can see why.");
  lines.push("- mcp__task_orch__check_criterion(criterion): mark an acceptance criterion done.");
  lines.push("- mcp__task_orch__uncheck_criterion(criterion): undo if you check the wrong one.");
  lines.push("- mcp__task_orch__add_criterion(text): add a criterion you discovered along the way.");
  lines.push("- mcp__task_orch__list_criteria(): see the current state of criteria.");
  lines.push("Use these as you work — don't batch them until the end. Match criteria by substring.");
  lines.push("");
  lines.push("# Finishing");
  lines.push("- Commit, then stop. Do NOT push, do NOT open the PR — the orchestrator does both.");
  lines.push("- Your final assistant message becomes the PR description. Write a clean summary:");
  lines.push("  - 1-3 sentences explaining what you did and why");
  lines.push("  - bullet list of the main files / behaviours that changed if non-trivial");
  lines.push("  - call out any caveats, follow-ups, or skipped acceptance criteria");
  return lines.join("\n");
}

/**
 * Template descriptor for the "Implement" run kind. The /api/runs POST
 * route accepts the run inputs directly; this struct is the shape the
 * task-page modal hands to that endpoint.
 */
export interface ImplementTemplate {
  goal: "<implement>";
  toolsProfile: "orchestrator,repo_write";
  cwdStrategy: "worktree";
  budget: { maxUsd: number };
  initialPrompt: string;
  taskId: string;
}

export function implementTemplate(task: TaskFull): ImplementTemplate {
  return {
    goal: "<implement>",
    toolsProfile: "orchestrator,repo_write",
    cwdStrategy: "worktree",
    budget: { maxUsd: IMPLEMENT_DEFAULT_BUDGET_USD },
    initialPrompt: buildImplementPrompt(task),
    taskId: task.id,
  };
}
