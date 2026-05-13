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
export const REVIEW_DEFAULT_BUDGET_USD = 5;

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

/**
 * Build the review-style agent prompt for a task with an open PR. The agent
 * is dropped into a worktree checked out at the PR's head ref, inspects the
 * diff via the gh_pr MCP tools, judges it against the task's acceptance
 * criteria, and ends with a structured JSON verdict block we parse back into
 * the run's `outcome` column.
 */
export function buildReviewPrompt(task: TaskFull, prUrl: string): string {
  const lines: string[] = [];
  lines.push(
    `You are a code-review agent inspecting an open pull request for task ${task.id}.`
  );
  lines.push("");
  lines.push(`# ${task.title}`);
  lines.push("");
  lines.push(`## Pull request under review`);
  lines.push(prUrl);
  if (task.body.trim()) {
    lines.push("");
    lines.push("## Task description");
    lines.push(task.body.trim());
  }

  // Acceptance criteria — numbered list so the verdict can reference them
  // by number. Both done and undone criteria are included so the reviewer
  // can verify ones the implementer already marked off.
  if (task.criteria.length > 0) {
    lines.push("");
    lines.push("## Acceptance criteria");
    task.criteria.forEach((c, i) => {
      lines.push(`${i + 1}. [${c.done ? "x" : " "}] ${c.text}`);
    });
  } else {
    lines.push("");
    lines.push("## Acceptance criteria");
    lines.push("(none defined — judge on general code quality and task description)");
  }

  if (task.notes.length > 0) {
    const recent = task.notes.slice(-5);
    lines.push("");
    lines.push("## Recent notes on the task");
    for (const n of recent) {
      lines.push(`- @${n.author}: ${n.body.trim().replace(/\n+/g, " ")}`);
    }
  }

  lines.push("");
  lines.push("# Working environment");
  lines.push(
    "- You are in a git worktree checked out at the PR's head commit. Read the diff via `git diff <base>...HEAD` or via the gh_pr tools."
  );
  lines.push(
    "- The `gh_pr` MCP server exposes `pr_view`, `pr_diff`, `pr_comments`, and similar tools — use them to load the PR's metadata, diff, CI status, and existing review comments."
  );
  lines.push("- This is a non-interactive run. Don't ask clarifying questions.");
  lines.push("- Do NOT push, do NOT modify files in the worktree, do NOT merge.");
  lines.push(
    "- If you want to leave a review on the PR itself, call `pr_review` with a body and one of approve / request_changes / comment. Optional — the orchestrator records your verdict regardless."
  );
  lines.push("");
  lines.push("# How to review");
  lines.push("1. Inspect the diff via gh_pr tools.");
  lines.push(
    "2. For each numbered acceptance criterion above, decide whether the diff satisfies it. Note any criteria that look unimplemented, partially implemented, or broken."
  );
  lines.push(
    "3. Look for obvious quality issues: dead code, missing tests, type errors, security holes, broken assumptions, scope creep."
  );
  lines.push("4. Form a final verdict.");
  lines.push("");
  lines.push("# Finishing");
  lines.push(
    "Write a short prose review (a paragraph or two), then end your final message with a single JSON code block exactly matching this shape:"
  );
  lines.push("");
  lines.push("```json");
  lines.push("{");
  lines.push(
    '  "verdict": "approve" | "request_changes" | "comment",'
  );
  lines.push('  "summary": "one sentence overall judgement",');
  lines.push(
    '  "concerns": ["specific issue 1", "specific issue 2", ...]'
  );
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push(
    "Use `approve` only if every acceptance criterion is satisfied and you have no blocking concerns. Use `request_changes` if anything looks wrong, missing, or unsafe. Use `comment` for neutral observations when the PR's status is ambiguous."
  );
  return lines.join("\n");
}

/**
 * Template descriptor for the "Review" run kind.
 */
export interface ReviewTemplate {
  goal: "<review>";
  toolsProfile: "orchestrator,repo_read,gh_pr";
  cwdStrategy: "worktree_at_pr";
  budget: { maxUsd: number };
  initialPrompt: string;
  taskId: string;
  prUrl: string;
}

export function reviewTemplate(task: TaskFull, prUrl: string): ReviewTemplate {
  return {
    goal: "<review>",
    toolsProfile: "orchestrator,repo_read,gh_pr",
    cwdStrategy: "worktree_at_pr",
    budget: { maxUsd: REVIEW_DEFAULT_BUDGET_USD },
    initialPrompt: buildReviewPrompt(task, prUrl),
    taskId: task.id,
    prUrl,
  };
}

// ──────────────────────────────────────────────────────────
// Outcome extraction (used by lib/runs.ts on stream end)
// ──────────────────────────────────────────────────────────

/**
 * Parse a final assistant message for a structured verdict JSON block. Used
 * by review-style runs to populate agent_runs.outcome. Returns a short
 * outcome string (capped at 200 chars) or null if no verdict was found.
 *
 * Looks for the LAST JSON object in the text that contains a "verdict"
 * field; falls back to the first non-empty line of the text if no
 * structured verdict is present.
 */
export function extractReviewOutcome(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Find all top-level `{ ... }` chunks containing "verdict" (greedy regex
  // wouldn't cope with nested braces; scan manually).
  const candidates = findJsonObjects(trimmed).filter((s) => /"verdict"\s*:/.test(s));

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === "object" && typeof parsed.verdict === "string") {
        const outcome = {
          verdict: String(parsed.verdict),
          summary:
            typeof parsed.summary === "string" ? parsed.summary : undefined,
        };
        let serialized = JSON.stringify(outcome);
        if (serialized.length > 200) {
          // Truncate summary so total fits in 200 chars.
          const overflow = serialized.length - 200;
          if (outcome.summary && outcome.summary.length > overflow + 1) {
            outcome.summary = outcome.summary.slice(0, outcome.summary.length - overflow - 1) + "…";
            serialized = JSON.stringify(outcome);
          } else {
            serialized = serialized.slice(0, 200);
          }
        }
        return serialized;
      }
    } catch {
      // Try the next candidate.
    }
  }

  // Fall back to the first non-empty line of the assistant text.
  const firstLine = trimmed.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return firstLine.slice(0, 200) || null;
}

/** Scan a string for balanced top-level `{ ... }` blocks. */
function findJsonObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(s.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}
