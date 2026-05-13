// spawn MCP server: lets a running agent spawn a child agent run and poll
// its progress. Mounted by lib/runs.ts when a run's tools_profile includes
// 'spawn'.
//
// This is the first MCP surface that creates new agent_runs rows from inside
// another run, so it carries the safety rails for the whole tree:
//
//   - Depth cap: the parent_run_id chain length must stay ≤ 3. Anything beyond
//     errors out. This prevents an agent from infinite-recursing into itself.
//
//   - Tree budget: the sum of total_cost_usd across the entire parent_run_id
//     subtree must stay under the root's budget_max_usd × TREE_BUDGET_MULT
//     (default 3, overridable via TASK_ORCH_TREE_BUDGET_MULT). Exceeding
//     triggers a `budget_exhausted`-shaped error response on the spawn attempt
//     (the new child is *not* created).
//
// Both checks run before `runs.create(...)`. Because `runs.create` already
// kicks off the worker asynchronously, the tool returns immediately with the
// new run_id; the parent can poll via `get_run(id)`.

import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agentSessions, agentMessages } from "@/db/schema";
import type { RunRow, CwdStrategy } from "./runs";
import * as runs from "./runs";

// ──────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────

/** Maximum depth of the parent_run_id chain. Root run has depth 0. */
export const MAX_DEPTH = 3;

/** Default multiplier applied to root.budget_max_usd to derive the tree cap. */
export const DEFAULT_TREE_BUDGET_MULT = 3;

function treeBudgetMult(): number {
  const raw = process.env.TASK_ORCH_TREE_BUDGET_MULT;
  if (!raw) return DEFAULT_TREE_BUDGET_MULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TREE_BUDGET_MULT;
  return n;
}

// ──────────────────────────────────────────────────────────
// Pure helpers (tested directly)
// ──────────────────────────────────────────────────────────

/**
 * Compute the depth of a run from its parent chain. Root = 0.
 *
 * `chain` is the ordered list of parent rows starting at the immediate
 * parent and walking up to the root. So for a run whose parent is the root,
 * `chain.length === 1` and depth is 1.
 */
export function computeDepth(chain: ReadonlyArray<{ parentRunId: number | null }>): number {
  return chain.length;
}

/**
 * Given a flat list of run rows that all belong to the same tree (root +
 * descendants), sum their total_cost_usd. Null costs count as 0.
 */
export function sumTreeCost(
  rows: ReadonlyArray<{ totalCostUsd: number | null }>
): number {
  let sum = 0;
  for (const r of rows) {
    if (typeof r.totalCostUsd === "number" && Number.isFinite(r.totalCostUsd)) {
      sum += r.totalCostUsd;
    }
  }
  return sum;
}

/**
 * Given a root run and the current spent total across the tree, decide if a
 * new spawn would be admissible. Returns null if OK; otherwise an error
 * descriptor with the budget cap and the current spend.
 *
 * If the root has no budget_max_usd, no cap is enforced (returns null).
 */
export function checkTreeBudget(
  root: { budgetMaxUsd: number | null },
  spentUsd: number,
  multiplier: number = DEFAULT_TREE_BUDGET_MULT
): { capUsd: number; spentUsd: number } | null {
  if (root.budgetMaxUsd == null) return null;
  const cap = root.budgetMaxUsd * multiplier;
  if (spentUsd >= cap) {
    return { capUsd: cap, spentUsd };
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// DB-backed helpers
// ──────────────────────────────────────────────────────────

interface ChainRow {
  id: number;
  parentRunId: number | null;
  budgetMaxUsd: number | null;
}

/**
 * Walk up parent_run_id from the given run. Returns the ordered chain of
 * ancestors (immediate parent first, root last). The starting run itself is
 * NOT included. Stops after `maxSteps` to bound work even on a cycle.
 */
function walkParentChain(startParentId: number | null, maxSteps = MAX_DEPTH + 2): ChainRow[] {
  const chain: ChainRow[] = [];
  let cursor: number | null = startParentId;
  const seen = new Set<number>();
  while (cursor != null && chain.length < maxSteps) {
    if (seen.has(cursor)) break; // cycle guard (should never happen)
    seen.add(cursor);
    const row = db
      .select({
        id: agentSessions.id,
        parentRunId: agentSessions.parentRunId,
        budgetMaxUsd: agentSessions.budgetMaxUsd,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, cursor))
      .get();
    if (!row) break;
    chain.push(row);
    cursor = row.parentRunId;
  }
  return chain;
}

/** Find the root (topmost ancestor) of a tree, given a run row. */
function findRoot(run: RunRow): ChainRow {
  if (run.parentRunId == null) {
    return {
      id: run.id,
      parentRunId: null,
      budgetMaxUsd: run.budgetMaxUsd,
    };
  }
  const chain = walkParentChain(run.parentRunId, 64);
  if (chain.length === 0) {
    // Parent vanished; treat self as root.
    return {
      id: run.id,
      parentRunId: null,
      budgetMaxUsd: run.budgetMaxUsd,
    };
  }
  return chain[chain.length - 1];
}

/**
 * Collect all rows that belong to the subtree rooted at `rootId` (inclusive).
 * Iterative BFS via parent_run_id; cheap because we only need (id, parentRunId,
 * totalCostUsd).
 */
function collectSubtree(
  rootId: number
): Array<{ id: number; parentRunId: number | null; totalCostUsd: number | null }> {
  const out: Array<{ id: number; parentRunId: number | null; totalCostUsd: number | null }> = [];
  const rootRow = db
    .select({
      id: agentSessions.id,
      parentRunId: agentSessions.parentRunId,
      totalCostUsd: agentSessions.totalCostUsd,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, rootId))
    .get();
  if (!rootRow) return out;
  out.push(rootRow);

  let frontier: number[] = [rootId];
  const seen = new Set<number>([rootId]);
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parentId of frontier) {
      const children = db
        .select({
          id: agentSessions.id,
          parentRunId: agentSessions.parentRunId,
          totalCostUsd: agentSessions.totalCostUsd,
        })
        .from(agentSessions)
        .where(eq(agentSessions.parentRunId, parentId))
        .all();
      for (const c of children) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        next.push(c.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Find the last agent text emitted on a run, by scanning agentMessages in
 * reverse. Returns null if no agent text is present.
 */
function lastAgentText(runId: number): string | null {
  const rows = db
    .select({ role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages)
    .where(eq(agentMessages.runId, runId))
    .all();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role !== "agent") continue;
    try {
      const parsed = JSON.parse(r.content) as Array<{ type?: string; text?: string }>;
      if (!Array.isArray(parsed)) continue;
      const text = parsed
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("\n")
        .trim();
      if (text) return text;
    } catch {
      // fall through
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export interface SpawnServerOptions {
  /** The parent run's id (the one calling spawn_agent). */
  runId: number;
  /** The parent run's row, for parentRunId / depth / repo inheritance. */
  runRow: RunRow;
}

export function createSpawnMcpServer({ runId, runRow }: SpawnServerOptions) {
  return createSdkMcpServer({
    name: "spawn",
    version: "0.1.0",
    tools: [
      tool(
        "spawn_agent",
        "Spawn a child agent run. Returns immediately with the new run_id; poll get_run(id) for status. Enforces a depth cap of 3 on the parent chain and a tree-wide cost cap.",
        {
          goal: z.string().min(1),
          tools_profile: z.string().min(1),
          cwd_strategy: z.enum(["worktree", "repo", "none"]),
          task_id: z.string().optional(),
          pr_url: z.string().optional(),
          repo_id: z.string().optional(),
          budget_max_usd: z.number().positive().optional(),
          budget_max_turns: z.number().int().positive().optional(),
          title: z.string().optional(),
          initial_prompt: z.string().optional(),
        },
        async (args) => {
          // 1. Depth check: parent chain length on the *new* child is the
          //    parent's chain length + 1 (the parent itself becomes an
          //    ancestor). So we count the parent's existing ancestors and
          //    add one.
          const parentChain = walkParentChain(runRow.parentRunId, MAX_DEPTH + 2);
          const newChildDepth = computeDepth(parentChain) + 1;
          if (newChildDepth > MAX_DEPTH) {
            return errResult(
              `Depth cap exceeded: spawning here would put the child at depth ${newChildDepth}, ` +
                `but the maximum is ${MAX_DEPTH}. Use the existing run instead of nesting deeper.`
            );
          }

          // 2. Tree-budget check: find the root, sum costs, compare to cap.
          const root = findRoot(runRow);
          const subtree = collectSubtree(root.id);
          const spent = sumTreeCost(subtree);
          const exceeded = checkTreeBudget(root, spent, treeBudgetMult());
          if (exceeded) {
            return errResult(
              JSON.stringify(
                {
                  error: "budget_exhausted",
                  message:
                    `Tree budget exhausted: spent $${exceeded.spentUsd.toFixed(4)} ` +
                    `≥ cap $${exceeded.capUsd.toFixed(4)} (root #${root.id}'s ` +
                    `budget_max_usd × ${treeBudgetMult()}).`,
                  root_run_id: root.id,
                  cap_usd: exceeded.capUsd,
                  spent_usd: exceeded.spentUsd,
                },
                null,
                2
              )
            );
          }

          // 3. Inherit repo from parent if not specified.
          const repoId = args.repo_id ?? runRow.repoId ?? null;

          // 4. Create the run. runs.create() kicks off the worker
          //    asynchronously for implement-style runs; for chat-style /
          //    deferred runs the new row sits at 'idle' / 'pending'.
          let newRun: RunRow;
          try {
            newRun = runs.create({
              goal: args.goal,
              toolsProfile: args.tools_profile,
              cwdStrategy: args.cwd_strategy as CwdStrategy,
              taskId: args.task_id ?? null,
              prUrl: args.pr_url ?? null,
              repoId,
              parentRunId: runId,
              userId: runRow.userId,
              title: args.title ?? null,
              budget: {
                maxUsd: args.budget_max_usd,
                maxTurns: args.budget_max_turns,
              },
              initialPrompt: args.initial_prompt ?? null,
              // If no task and not <implement>, runs.create will not kick
              // off the implement worker; chat-style runs wait for append.
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return errResult(`Failed to create child run: ${msg}`);
          }

          return ok(
            JSON.stringify(
              {
                run_id: newRun.id,
                status: newRun.status,
                parent_run_id: newRun.parentRunId,
                depth: newChildDepth,
                tree_root_id: root.id,
                tree_spent_usd: spent,
                tree_cap_usd:
                  root.budgetMaxUsd != null
                    ? root.budgetMaxUsd * treeBudgetMult()
                    : null,
                url: `/runs/${newRun.id}`,
              },
              null,
              2
            )
          );
        }
      ),
      tool(
        "get_run",
        "Look up a run by id and return its current status, outcome, and last agent text. Used to poll a previously spawned child.",
        { id: z.number().int().positive() },
        async ({ id }) => {
          const run = runs.get(id);
          if (!run) {
            return errResult(`Run ${id} not found.`);
          }
          const lastText = lastAgentText(id);
          return ok(
            JSON.stringify(
              {
                id: run.id,
                status: run.status,
                outcome: run.outcome,
                last_text: lastText,
                pr_url: run.prUrl,
                total_cost_usd: run.totalCostUsd,
                parent_run_id: run.parentRunId,
                started_at: run.startedAt.toISOString(),
                completed_at: run.completedAt?.toISOString() ?? null,
                error: run.error,
              },
              null,
              2
            )
          );
        }
      ),
    ],
  });
}
