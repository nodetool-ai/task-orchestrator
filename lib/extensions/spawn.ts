// lib/extensions/spawn.ts
//
// spawn extension: pi-side replacement for lib/spawn-mcp.ts. Tools:
//   - spawn__spawn_agent (now requires `persona`)
//   - spawn__get_run
//   - spawn__append_message
//
// Pure helpers re-exported for direct unit testing.

import { Type } from "typebox";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agentSessions, agentMessages } from "@/db/schema";
import * as repo from "../repo";
import * as runs from "../runs";
import type { RunRow, CwdStrategy } from "../runs";
import { listProfiles } from "../profiles";
import type { ExtensionFactory } from "./types";

// ────────────────────────────────────────
// Constants
// ────────────────────────────────────────

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

// ────────────────────────────────────────
// Pure helpers (verbatim from lib/spawn-mcp.ts; re-exported for tests)
// ────────────────────────────────────────

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

/**
 * Pure helper: extract the latest assistant text from a list of message rows
 * (ordered oldest → newest). Returns the joined text blocks of the last row
 * whose role is "agent" and that has at least one non-empty text block.
 * Returns null otherwise.
 *
 * Exported for unit-testing without DB setup.
 */
export function extractLatestAssistantText(
  rows: ReadonlyArray<{ role: string; content: string }>
): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role !== "agent") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const text = (parsed as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

/**
 * Pure validator: is every entry of a comma-separated `tools_profile` string a
 * known profile key? Returns null when valid, or an error message naming the
 * unknown entries and listing the valid registry otherwise.
 *
 * The runner only discovers an unknown profile deep inside resolveProfiles()
 * (one turn in, after a worktree may already exist), which marks the spawned
 * run `failed` a second later. Validating here lets spawn_agent reject the bad
 * call up front with an actionable list, so the agent self-corrects instead of
 * littering the run list with instant-fail children. Mirrors the persona check.
 */
export function checkToolsProfile(profileString: string): string | null {
  const valid = listProfiles();
  const names = profileString
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) {
    return `tools_profile is empty. Valid profiles: ${valid.join(", ")}.`;
  }
  const unknown = names.filter((n) => !valid.includes(n));
  if (unknown.length > 0) {
    return (
      `Unknown tools profile${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
      `Valid profiles: ${valid.join(", ")}. ` +
      `tools_profile is a comma-separated list of these keys.`
    );
  }
  return null;
}

/**
 * Pure guard: would a spawned run with this (cwd_strategy, task_id) actually be
 * picked up by a worker? Returns null when it auto-starts, or an error message
 * otherwise.
 *
 * spawn_agent goals are always free-form (never the special '<chat>'/'<execute>'
 * sentinels), so runs.create() only kicks off a worker for `worktree` + a
 * task_id (the implement lifecycle). A `repo`/`none` spawn — or a `worktree`
 * spawn with no task_id — is inserted at `pending` and then nothing runs it: it
 * hangs forever, and the <implement>-only reaper never cleans it up (that is
 * exactly how run #85 got stuck). Reject up front instead of minting a zombie.
 */
export function checkSpawnStartable(args: {
  cwdStrategy: string;
  taskId?: string | null;
}): string | null {
  if (args.cwdStrategy === "worktree") {
    if (!args.taskId) {
      return (
        `cwd_strategy=worktree spawns an implement-style child that branches off a ` +
        `task; pass task_id. To review a PR instead, use the start_review tool.`
      );
    }
    return null;
  }
  return (
    `cwd_strategy='${args.cwdStrategy}' isn't startable via spawn_agent: no worker ` +
    `runs a free-form ${args.cwdStrategy} child, so it would hang at 'pending' forever. ` +
    `Use cwd_strategy=worktree with a task_id to implement a task, or the start_review tool ` +
    `to review a PR.`
  );
}

/**
 * Pure predicate: should an append_message call be refused because the target
 * run is in a state from which it cannot be resumed?
 *
 * Returns null if the append is admissible, or an error message otherwise.
 */
export function checkAppendableStatus(status: string): string | null {
  if (status === "closed") {
    return `Run is closed; cannot append. Closed runs are archived and must be forked to continue.`;
  }
  if (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "budget_exhausted"
  ) {
    return `Run is in terminal status '${status}'; cannot append.`;
  }
  return null;
}

// ────────────────────────────────────────
// DB-backed helpers (verbatim from lib/spawn-mcp.ts)
// ────────────────────────────────────────

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
  return extractLatestAssistantText(rows);
}

// ────────────────────────────────────────
// Extension factory
// ────────────────────────────────────────

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const errResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });

export interface SpawnExtensionOptions {
  runId: number;
  runRow: RunRow;
}

export const spawnExtension =
  ({ runId, runRow }: SpawnExtensionOptions): ExtensionFactory =>
  (reg) => {
    reg.registerTool({
      name: "spawn__spawn_agent",
      label: "Spawn Agent",
      description:
        "Spawn a child agent run. Returns immediately with the new run_id; poll spawn__get_run(id) for status. Enforces a depth cap of 3 on the parent chain and a tree-wide cost cap. The 'persona' field selects the agent role (reviewer | implementor | planner | designer | qa).",
      parameters: Type.Object({
        goal: Type.String({ minLength: 1 }),
        persona: Type.String({ minLength: 1 }),
        reasoning: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")], {
            description: "Reasoning level for the child agent. Omit to use the persona's default.",
          })
        ),
        tools_profile: Type.String({
          minLength: 1,
          description:
            "Comma-separated list of tool-profile keys. Valid keys: orchestrator " +
            "(plans/tasks/notes), repo_write, repo_read, gh_pr, gh_ci, spawn, planning. " +
            "Typical implementor: 'orchestrator,repo_write,gh_pr,gh_ci'; reviewer: " +
            "'orchestrator,repo_read,gh_pr'. These are NOT free-form (e.g. 'default'/'code' are invalid).",
        }),
        cwd_strategy: Type.Union(
          [Type.Literal("worktree"), Type.Literal("repo"), Type.Literal("none")],
          {
            description:
              "Working-directory strategy. Use 'worktree' (with task_id) to implement a task " +
              "on a fresh branch — this is the only strategy spawn_agent auto-starts. 'repo'/'none' " +
              "are not picked up by any worker here and would hang at 'pending'; review PRs via the " +
              "start_review tool instead.",
          }
        ),
        task_id: Type.Optional(Type.String()),
        pr_url: Type.Optional(Type.String()),
        repo_id: Type.Optional(Type.String()),
        budget_max_usd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        budget_max_turns: Type.Optional(Type.Integer({ minimum: 1 })),
        title: Type.Optional(Type.String()),
        initial_prompt: Type.Optional(Type.String()),
      }),
      execute: async (_id, args) => {
        // 1. Persona validation BEFORE the depth/budget checks (cheap fail first).
        const validIds = repo.listPersonaIds();
        if (!validIds.includes(args.persona)) {
          return errResult(
            `Unknown persona '${args.persona}'. Valid: ${validIds.join(", ")}`
          );
        }

        // 1b. tools_profile validation. Without this, an unknown profile is only
        //     caught one turn in by resolveProfiles(), after the child run is
        //     created and marked `failed` — exactly how 'default'/'code' guesses
        //     left a trail of dead child runs. Reject up front instead.
        const profileError = checkToolsProfile(args.tools_profile);
        if (profileError) {
          return errResult(profileError);
        }

        // 1c. Startability guard. A repo/none spawn (or a worktree spawn with no
        //     task_id) is inserted at `pending` and then never picked up by any
        //     worker — it hangs forever (run #85). Reject instead of minting a
        //     zombie the agent will poll indefinitely.
        const startableError = checkSpawnStartable({
          cwdStrategy: args.cwd_strategy,
          taskId: args.task_id ?? null,
        });
        if (startableError) {
          return errResult(startableError);
        }

        // 2. Depth check.
        const parentChain = walkParentChain(runRow.parentRunId, MAX_DEPTH + 2);
        const newChildDepth = computeDepth(parentChain) + 1;
        if (newChildDepth > MAX_DEPTH) {
          return errResult(
            `Depth cap exceeded: spawning here would put the child at depth ${newChildDepth}, ` +
              `but the maximum is ${MAX_DEPTH}. Use the existing run instead of nesting deeper.`
          );
        }

        // 3. Tree-budget check.
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

        // 4. Inherit repo from parent if not specified.
        const repoId = args.repo_id ?? runRow.repoId ?? null;

        // 5. Create the run with the persona id.
        let newRun: RunRow;
        try {
          newRun = runs.create({
            goal: args.goal,
            personaId: args.persona,
            thinkingLevel: args.reasoning ?? null,
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
      },
    });

    reg.registerTool({
      name: "spawn__get_run",
      label: "Get Run",
      description:
        "Look up a run by id and return its current status, outcome, and last agent text. Used to poll a previously spawned child.",
      parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
      execute: async (_id, { id }) => {
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
      },
    });

    reg.registerTool({
      name: "spawn__append_message",
      label: "Append Message",
      description:
        "Send a user message to an existing run, resuming its SDK session. Uses the same per-run lock as the UI composer, so this is safe to call concurrently with the UI. When await=true, blocks until the run returns to idle (or a terminal state) and returns the new agent text. Refuses on runs in a terminal status (closed/completed/failed/cancelled/budget_exhausted). Same tree-budget cap as spawn__spawn_agent.",
      parameters: Type.Object({
        run_id: Type.Integer({ minimum: 1 }),
        text: Type.String({ minLength: 1 }),
        await: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, args) => {
        // 1. Tree-budget enforcement based on the *caller's* tree.
        const callerRoot = findRoot(runRow);
        const callerSubtree = collectSubtree(callerRoot.id);
        const spent = sumTreeCost(callerSubtree);
        const exceeded = checkTreeBudget(callerRoot, spent, treeBudgetMult());
        if (exceeded) {
          return errResult(
            JSON.stringify(
              {
                error: "budget_exhausted",
                message:
                  `Tree budget exhausted: spent $${exceeded.spentUsd.toFixed(4)} ` +
                  `≥ cap $${exceeded.capUsd.toFixed(4)} (root #${callerRoot.id}'s ` +
                  `budget_max_usd × ${treeBudgetMult()}).`,
                root_run_id: callerRoot.id,
                cap_usd: exceeded.capUsd,
                spent_usd: exceeded.spentUsd,
              },
              null,
              2
            )
          );
        }

        // 2. Look up the target run; refuse on closed / terminal BEFORE
        //    grabbing the per-run lock.
        const target = runs.get(args.run_id);
        if (!target) {
          return errResult(`Run ${args.run_id} not found.`);
        }
        const refusal = checkAppendableStatus(target.status);
        if (refusal) {
          return errResult(refusal);
        }

        const awaitIdle = args.await === true;

        // 3. Fire the append.
        let appendError: string | null = null;
        const drain = (async () => {
          try {
            for await (const event of runs.append({
              runId: args.run_id,
              role: "user",
              text: args.text,
            })) {
              if (event.type === "error") {
                appendError = event.error ?? "append failed";
              }
              if (event.type === "done" || event.type === "error") break;
            }
          } catch (err) {
            appendError = err instanceof Error ? err.message : String(err);
          }
        })();

        if (!awaitIdle) {
          const racedError = await Promise.race([
            drain.then(() => null),
            new Promise<null>((res) => setImmediate(() => res(null))),
          ]);
          void racedError;
          return ok(
            JSON.stringify(
              {
                run_id: args.run_id,
                status: "running",
                awaited: false,
                tree_root_id: callerRoot.id,
                tree_spent_usd: spent,
                tree_cap_usd:
                  callerRoot.budgetMaxUsd != null
                    ? callerRoot.budgetMaxUsd * treeBudgetMult()
                    : null,
              },
              null,
              2
            )
          );
        }

        // 4. Awaiting path: `drain` resolves only when runs.append's generator
        //    completes, which happens once the turn reaches a terminal status
        //    (it yields `done` last) — that is the terminal signal. A
        //    pre-append runs.subscribe() would be a no-op here anyway: the
        //    run's event bus only exists while the turn is live, i.e. after
        //    append has already started.
        await drain.catch(() => {});

        if (appendError) {
          return errResult(`append failed: ${appendError}`);
        }

        const after = runs.get(args.run_id);
        const latestText = lastAgentText(args.run_id);
        return ok(
          JSON.stringify(
            {
              run_id: args.run_id,
              status: after?.status ?? "idle",
              awaited: true,
              last_text: latestText,
              total_cost_usd: after?.totalCostUsd ?? null,
              tree_root_id: callerRoot.id,
            },
            null,
            2
          )
        );
      },
    });
  };
