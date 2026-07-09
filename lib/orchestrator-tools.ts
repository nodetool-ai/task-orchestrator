// lib/orchestrator-tools.ts
//
// Shared registry of the 37 orchestrator tool definitions.
// The pi extension consumes this and registers each with the task_orch__ prefix.
// The MCP server consumes this directly (bare names).

import { Type, type TSchema } from "typebox";
import * as repo from "./repo";
import * as agentLib from "./agent";
import * as runs from "./runs";
import { parseReviewVerdict } from "./run-templates";
import { parsePrUrl } from "./gh-url";
import { db } from "@/db";
import { agentSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  PLAN_STATES,
  TASK_STATES,
  TASK_TRANSITIONS,
  isTerminalStatus,
  type PlanState,
  type TaskState,
} from "./types";
import { createTimer, TIMER_MAX_MINUTES, TIMER_MIN_MINUTES } from "./inbox";
import { recordTurnEffect } from "./run-state";

// Derived from TASK_TRANSITIONS so the transition_task description can never
// drift from the actual allowed edges (a hardcoded list silently goes stale
// when the state machine changes — as it did once already).
const ALLOWED_TASK_TRANSITIONS_TEXT = (
  Object.entries(TASK_TRANSITIONS) as [TaskState, TaskState[]][]
)
  .filter(([, to]) => to.length > 0)
  .map(([from, to]) => `${from}→${to.join("/")}`)
  .join(", ");
import type { TaskFull, PlanFull, AgentSessionFull, AttachmentMeta } from "./types";

// ──────────────────────────────────────────────────────
// Context and result types
// ──────────────────────────────────────────────────────

export interface OrchestratorToolContext {
  author: string;
  defaultTaskId?: string;
  defaultPlanId?: string;
  /** The run this tool is executing inside, if any. Child runs spawned by
   *  start_session are parented to it so they group in the UI
   *  and share the tree budget. Undefined when invoked via the MCP server. */
  runId?: number;
}

// Content blocks an orchestrator tool may return. Both the MCP server and the
// pi runtime accept `image` blocks (base64 + mime), so get_attachment can hand
// an actual image back to the model rather than a link it can't open.
export type OrchestratorContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface OrchestratorToolResult {
  content: OrchestratorContentBlock[];
  isError?: boolean;
}

export interface OrchestratorTool<TParams = any> {
  /** Bare name (no `task_orch__` prefix). MCP exposes this directly; the
   *  pi extension prepends `task_orch__`. */
  name: string;
  /** Human-readable label, e.g. "List Plans". */
  label: string;
  description: string;
  parameters: TSchema;
  execute: (params: TParams, ctx: OrchestratorToolContext) => Promise<OrchestratorToolResult>;
}

// ──────────────────────────────────────────────────────
// Local helpers
// ──────────────────────────────────────────────────────

const ok = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
});

const errResult = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

const jsonResult = (value: unknown): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

// Resolve task_id from arg or default; null means caller must specify.
const resolveTaskId = (provided: string | undefined, ctx: OrchestratorToolContext): string | null => {
  if (provided && provided.trim()) return provided.trim();
  return ctx.defaultTaskId ?? null;
};

// Resolve plan_id from arg or default; null means caller must specify.
const resolvePlanId = (provided: string | undefined, ctx: OrchestratorToolContext): string | null => {
  if (provided && provided.trim()) return provided.trim();
  return ctx.defaultPlanId ?? null;
};

// Spawned children (start_session) inherit the spawner's user
// attribution. The tool context only carries the run id, so resolve userId off
// the spawning run's row; null when invoked outside a run (e.g. the MCP
// server) or when the spawner itself has no user.
const resolveSpawnerUserId = async (ctx: OrchestratorToolContext): Promise<number | null> => {
  if (ctx.runId == null) return null;
  const spawner = await runs.get(ctx.runId);
  return spawner?.userId ?? null;
};

// Max bytes we inline an image for the model; bigger images are referenced by
// download URL instead. Text artifacts inline up to a char cap, then truncate.
const IMAGE_INLINE_MAX = 5 * 1024 * 1024;
const TEXT_INLINE_MAX_CHARS = 100_000;

// Resolve which owner an attachment op targets. Explicit task_id/plan_id wins;
// otherwise fall back to the session's scoped task, then its scoped plan.
const resolveAttachmentOwner = (
  taskId: string | undefined,
  planId: string | undefined,
  ctx: OrchestratorToolContext
): { taskId?: string; planId?: string } | null => {
  if (taskId && taskId.trim()) return { taskId: taskId.trim() };
  if (planId && planId.trim()) return { planId: planId.trim() };
  if (ctx.defaultTaskId) return { taskId: ctx.defaultTaskId };
  if (ctx.defaultPlanId) return { planId: ctx.defaultPlanId };
  return null;
};

const findCriterion = async (taskId: string, needle: string) => {
  const task = await repo.getTask(taskId);
  if (!task) return null;
  const byId = task.criteria.find((c) => String(c.id) === needle);
  if (byId) return byId;
  const lowered = needle.toLowerCase();
  return (
    task.criteria.find((c) => c.text.toLowerCase() === lowered) ??
    task.criteria.find((c) => c.text.toLowerCase().includes(lowered)) ??
    null
  );
};

// States a plan may be *created* in. Full PLAN_STATES also includes
// 'accepted'/'done'/'cancelled' — allowing those at creation would let a
// caller mint a plan that's already past review (or terminal) and never went
// through transition_plan, silently bypassing the lifecycle. 'draft' (the
// default) and 'proposed' (a plan submitted for review without a separate
// draft step) are the only initial states callers actually need.
const PLAN_CREATE_STATES = ["draft", "proposed"] as const satisfies readonly PlanState[];

async function safe<T>(fn: () => Promise<T> | T): Promise<T | { _error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof repo.RepoError) return { _error: e.message };
    return { _error: e instanceof Error ? e.message : String(e) };
  }
}

// ──────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────

async function summarisePlan(p: PlanFull) {
  const progress = await repo.planProgress(p.id);
  return {
    id: p.id,
    title: p.title,
    state: p.state,
    owner: p.owner,
    tags: p.tags,
    repos: p.repos.map((r) => r.id),
    progress: `${progress.done}/${progress.total} done (${progress.pct}%)`,
    updated_at: p.updatedAt.toISOString(),
  };
}

function summariseTask(t: TaskFull) {
  return {
    id: t.id,
    title: t.title,
    state: t.state,
    plan_id: t.planId,
    repo_id: t.repoId,
    assignee: t.assignee,
    estimate: t.estimate,
    tags: t.tags,
    deps: t.dependencies,
    open_criteria: t.criteria.filter((c) => !c.done).length,
    total_criteria: t.criteria.length,
    updated_at: t.updatedAt.toISOString(),
  };
}

function summariseAttachment(a: AttachmentMeta) {
  return {
    id: a.id,
    filename: a.filename,
    kind: a.kind,
    mime_type: a.mimeType,
    size_bytes: a.sizeBytes,
    plan_id: a.planId,
    task_id: a.taskId,
    author: a.author,
    created_at: a.createdAt.toISOString(),
  };
}

// Mime types we hand back to the model as decoded UTF-8 text rather than
// base64. Covers the common artifact shapes (logs, source, json, csv, svg).
function isTextualMime(mime: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith("text/")) return true;
  return (
    m === "application/json" ||
    m === "application/xml" ||
    m === "image/svg+xml" ||
    m.endsWith("+json") ||
    m.endsWith("+xml") ||
    m === "application/javascript" ||
    m === "application/x-yaml" ||
    m === "application/yaml"
  );
}

function summariseSession(s: AgentSessionFull) {
  return {
    id: s.id,
    task_id: s.taskId,
    status: s.status,
    model: s.model,
    branch: s.branch,
    pr_url: s.prUrl,
    cost_usd: s.totalCostUsd,
    started_at: s.startedAt.toISOString(),
    completed_at: s.completedAt?.toISOString() ?? null,
    error: s.error,
  };
}

// ──────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────

export const ORCHESTRATOR_TOOLS: OrchestratorTool[] = [
  // ── Repositories ──────────────────────────────────────

  {
    name: "list_repositories",
    label: "List Repositories",
    description:
      "List configured repositories. Each repository is a git checkout the orchestrator can drive (worktrees for sessions, cwd for chat agents).",
    parameters: Type.Object({}),
    execute: async (_params, _ctx) => {
      return jsonResult(
        (await repo.listRepositories()).map((r) => ({
          id: r.id,
          name: r.name,
          local_path: r.localPath,
          remote: r.remote,
          default_branch: r.defaultBranch,
          description: r.description,
        }))
      );
    },
  },

  {
    name: "get_repository",
    label: "Get Repository",
    description: "Get a repository's full details.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async ({ id }, _ctx) => {
      const r = await repo.getRepository(id);
      if (!r) return errResult(`Error: Repository ${id} not found`);
      return jsonResult({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      });
    },
  },

  {
    name: "create_repository",
    label: "Create Repository",
    description:
      "Register a new repository. local_path should point at a git checkout the service user can read and (for agent sessions) write to.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1 }),
      local_path: Type.Optional(Type.String()),
      remote: Type.Optional(Type.String()),
      default_branch: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    execute: async (input, _ctx) => {
      const result = await safe(() =>
        repo.createRepository({
          name: input.name,
          localPath: input.local_path,
          remote: input.remote,
          defaultBranch: input.default_branch,
          description: input.description,
        })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Created repository ${result.id}: ${result.name}`);
    },
  },

  {
    name: "update_repository",
    label: "Update Repository",
    description:
      "Patch a repository's name, local_path, remote, default_branch, or description.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      name: Type.Optional(Type.String()),
      local_path: Type.Optional(Type.String()),
      remote: Type.Optional(Type.String()),
      default_branch: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    execute: async ({ id, ...patch }, _ctx) => {
      const result = await safe(() =>
        repo.updateRepository(id, {
          name: patch.name,
          localPath: patch.local_path ?? undefined,
          remote: patch.remote ?? undefined,
          defaultBranch: patch.default_branch,
          description: patch.description,
        })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Updated repository ${result.id}.`);
    },
  },

  {
    name: "delete_repository",
    label: "Delete Repository",
    description:
      "Delete a repository. Blocked if any plans or chats still reference it; reassign them first.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async ({ id }, _ctx) => {
      const result = await safe(() => repo.deleteRepository(id));
      if (result && typeof result === "object" && "_error" in result)
        return errResult(`Error: ${(result as { _error: string })._error}`);
      return ok(`Deleted repository ${id}.`);
    },
  },

  // ── Plans ──────────────────────────────────────────────

  {
    name: "list_plans",
    label: "List Plans",
    description: "List all plans. Optionally filter by state.",
    parameters: Type.Object({
      state: Type.Optional(
        Type.Union(PLAN_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]])
      ),
    }),
    execute: async ({ state }, _ctx) => {
      const plans = await repo.listPlans();
      const filtered = state ? plans.filter((p) => p.state === (state as PlanState)) : plans;
      return jsonResult(await Promise.all(filtered.map(summarisePlan)));
    },
  },

  {
    name: "get_plan",
    label: "Get Plan",
    description:
      "Get full details for a plan including its tasks (summarized). Defaults to the chat's plan when no id is given.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    execute: async ({ id }, ctx) => {
      const planId = resolvePlanId(id, ctx);
      if (!planId) return errResult("Error: plan id required (no default plan in this session)");
      const plan = await repo.getPlan(planId);
      if (!plan) return errResult(`Error: Plan ${planId} not found`);
      const tasksInPlan = (await repo.listTasks({ planId })).map(summariseTask);
      return jsonResult({
        ...plan,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString(),
        progress: await repo.planProgress(planId),
        tasks: tasksInPlan,
      });
    },
  },

  {
    name: "create_plan",
    label: "Create Plan",
    description:
      "Create a new plan across one or more repositories. Returns the plan id. Tasks under this plan must target one of the listed repositories. If repo_ids is omitted, defaults to [the default repo]. state defaults to 'draft' and may only be set to 'draft' or 'proposed' at creation — 'accepted'/'done'/'cancelled' would skip the plan's review lifecycle; use transition_plan to advance a plan through its states.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      body: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      state: Type.Optional(
        Type.Union(
          PLAN_CREATE_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]],
          { description: "Initial state. Defaults to 'draft'. Only 'draft' or 'proposed' are allowed here — reach 'accepted'/'done'/'cancelled' via transition_plan." }
        )
      ),
      repo_ids: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (input, _ctx) => {
      const result = await safe(() =>
        repo.createPlan({
          title: input.title,
          body: input.body,
          owner: input.owner,
          tags: input.tags,
          state: input.state as PlanState | undefined,
          repoIds: input.repo_ids,
        })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(
        `Created plan ${result.id}: ${result.title} (${result.repos.length} repo${result.repos.length === 1 ? "" : "s"})`
      );
    },
  },

  {
    name: "update_plan",
    label: "Update Plan",
    description:
      "Patch a plan's title, body, owner, tags, or entire repository set (repo_ids replaces all). Defaults to the chat's plan when no id is given. Use add_plan_repository/remove_plan_repository for granular changes. Use transition_plan to change state.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      repo_ids: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async ({ id, ...patch }, ctx) => {
      const planId = resolvePlanId(id, ctx);
      if (!planId) return errResult("Error: plan id required");
      const result = await safe(() =>
        repo.updatePlan(planId, {
          title: patch.title,
          body: patch.body,
          owner: patch.owner ?? undefined,
          tags: patch.tags,
          repoIds: patch.repo_ids,
        })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(
        `Updated plan ${result.id} (state: ${result.state}, ${result.repos.length} repo${result.repos.length === 1 ? "" : "s"}).`
      );
    },
  },

  {
    name: "add_plan_repository",
    label: "Add Plan Repository",
    description:
      "Attach an additional repository to a plan. plan_id defaults to the chat's plan when scoped to one. The new repo becomes the last in the plan's repo list. No-op if already attached.",
    parameters: Type.Object({
      plan_id: Type.Optional(Type.String()),
      repo_id: Type.String({ minLength: 1 }),
    }),
    execute: async ({ plan_id, repo_id }, ctx) => {
      const planId = resolvePlanId(plan_id, ctx);
      if (!planId) return errResult("Error: plan_id required");
      const result = await safe(() => repo.addPlanRepository(planId, repo_id));
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Plan ${result.id} now spans ${result.repos.map((r) => r.id).join(", ")}.`);
    },
  },

  {
    name: "remove_plan_repository",
    label: "Remove Plan Repository",
    description:
      "Detach a repository from a plan. plan_id defaults to the chat's plan when scoped to one. Any tasks pinned to it are unset and will refuse to start until reassigned.",
    parameters: Type.Object({
      plan_id: Type.Optional(Type.String()),
      repo_id: Type.String({ minLength: 1 }),
    }),
    execute: async ({ plan_id, repo_id }, ctx) => {
      const planId = resolvePlanId(plan_id, ctx);
      if (!planId) return errResult("Error: plan_id required");
      const result = await safe(() => repo.removePlanRepository(planId, repo_id));
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(
        `Plan ${result.id} now spans ${result.repos.map((r) => r.id).join(", ") || "(no repos)"}.`
      );
    },
  },

  {
    name: "transition_plan",
    label: "Transition Plan",
    description:
      "Change a plan's state. Defaults to the chat's plan when no id is given. Allowed transitions: draft→proposed/accepted/cancelled, proposed→accepted/cancelled, accepted→done/cancelled.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      state: Type.Union(PLAN_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
    }),
    execute: async ({ id, state }, ctx) => {
      const planId = resolvePlanId(id, ctx);
      if (!planId) return errResult("Error: plan id required");
      const result = await safe(() => repo.updatePlan(planId, { state: state as PlanState }));
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Plan ${result.id} → ${result.state}.`);
    },
  },

  {
    name: "delete_plan",
    label: "Delete Plan",
    description:
      "Delete a plan. CASCADES — destroys all tasks, criteria, notes, and sessions under it. Requires an explicit id (never defaulted) to avoid accidental destruction. Refuses if the plan or any of its tasks has an active (non-terminal) agent run — cancel those with cancel_session first, since the cascade would delete a live run's row out from under it.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async ({ id }, _ctx) => {
      const existing = await repo.getPlan(id);
      if (!existing) return errResult(`Error: Plan ${id} not found`);
      // tasks→plans and agent_sessions.taskId→tasks both ON DELETE CASCADE:
      // deleting the plan while a run is live would vaporize that run's row
      // mid-turn (worker's next get(runId) throws, worktree leaks, the SDK
      // process keeps burning with no cancel handle). Refuse instead.
      const tasksInPlan = await repo.listTasks({ planId: id });
      const [planRuns, ...taskRunLists] = await Promise.all([
        runs.list({ planId: id, activeOnly: true }),
        ...tasksInPlan.map((t) => runs.list({ taskId: t.id, activeOnly: true })),
      ]);
      const activeRuns = [...planRuns, ...taskRunLists.flat()];
      if (activeRuns.length > 0) {
        return errResult(
          `Error: Plan ${id} has ${activeRuns.length} active run(s) (${activeRuns
            .map((r) => `#${r.id}`)
            .join(", ")}) on it or its tasks. Cancel them with cancel_session before deleting the plan.`
        );
      }
      await repo.deletePlan(id);
      return ok(`Deleted plan ${id}.`);
    },
  },

  // ── Tasks ──────────────────────────────────────────────

  {
    name: "list_tasks",
    label: "List Tasks",
    description:
      "List tasks. Filter by state, plan_id, and/or assignee. plan_id defaults to the chat's plan when scoped to one.",
    parameters: Type.Object({
      state: Type.Optional(
        Type.Union(TASK_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]])
      ),
      plan_id: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String()),
    }),
    execute: async ({ state, plan_id, assignee }, ctx) => {
      const planId = plan_id ?? ctx.defaultPlanId ?? undefined;
      const tasks = await repo.listTasks({ state: state as TaskState | undefined, planId, assignee });
      return jsonResult(tasks.map(summariseTask));
    },
  },

  {
    name: "get_task",
    label: "Get Task",
    description:
      "Get full task details (body, criteria, notes, deps). Defaults to your current task if no id given.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    execute: async ({ id }, ctx) => {
      const taskId = resolveTaskId(id, ctx);
      if (!taskId) return errResult("Error: task id required (no default task in this session)");
      const t = await repo.getTask(taskId);
      if (!t) return errResult(`Error: Task ${taskId} not found`);
      return jsonResult({
        ...t,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        notes: t.notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
      });
    },
  },

  {
    name: "create_task",
    label: "Create Task",
    description:
      "Create a new task under a plan. plan_id defaults to the chat's plan when scoped to one. The task targets one of the plan's repositories: if the plan has exactly one repo it's inherited, otherwise repo_id is required and must be in the plan's set.",
    parameters: Type.Object({
      plan_id: Type.Optional(Type.String()),
      title: Type.String({ minLength: 1 }),
      body: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String()),
      estimate: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      dependencies: Type.Optional(Type.Array(Type.String())),
      criteria: Type.Optional(Type.Array(Type.String())),
      repo_id: Type.Optional(Type.String()),
    }),
    execute: async (input, ctx) => {
      const planId = resolvePlanId(input.plan_id, ctx);
      if (!planId) return errResult("Error: plan_id required (no default plan in this session)");
      const result = await safe(() =>
        repo.createTask({
          planId,
          title: input.title,
          body: input.body,
          assignee: input.assignee ?? undefined,
          estimate: input.estimate ?? undefined,
          tags: input.tags,
          dependencies: input.dependencies,
          criteria: input.criteria,
          repoId: input.repo_id,
        })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(
        `Created task ${result.id}: ${result.title}${result.repoId ? ` → ${result.repoId}` : ""}`
      );
    },
  },

  {
    name: "update_task",
    label: "Update Task",
    description:
      "Patch a task's fields (title, body, assignee, estimate, tags, dependencies, repo_id). The new repo_id must be one of the plan's repositories. Use transition_task to change state.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      assignee: Type.Optional(Type.String()),
      estimate: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      dependencies: Type.Optional(Type.Array(Type.String())),
      repo_id: Type.Optional(Type.String()),
    }),
    execute: async ({ id, ...patch }, ctx) => {
      const taskId = resolveTaskId(id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const result = await safe(() =>
        repo.updateTask(taskId, {
          title: patch.title,
          body: patch.body,
          assignee: patch.assignee ?? undefined,
          estimate: patch.estimate ?? undefined,
          tags: patch.tags,
          dependencies: patch.dependencies,
          repoId: patch.repo_id === undefined ? undefined : patch.repo_id,
        })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Updated task ${result.id}.`);
    },
  },

  {
    name: "transition_task",
    label: "Transition Task",
    description:
      `Change a task's state with optional note and assignee. Allowed: ${ALLOWED_TASK_TRANSITIONS_TEXT}. merged and cancelled are terminal. Going to in_progress requires an assignee. Going to merged requires all acceptance criteria checked. Note: testing/passing/failing/merged are normally driven from the PR's real GitHub/CI state, not set by hand.`,
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      state: Type.Union(TASK_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
      assignee: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
    }),
    execute: async ({ id, state, assignee, note }, ctx) => {
      const taskId = resolveTaskId(id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const result = await safe(() =>
        repo.transitionTask(taskId, { state: state as TaskState, assignee, note })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Task ${result.id} → ${result.state}.`);
    },
  },

  {
    name: "set_task_pr",
    label: "Set Task PR",
    description:
      "Record this task's pull request URL. Call this every time you open (or re-open) a PR for a task — it's the durable link the orchestrator, CI polling, and the UI use to find the task's PR. If the task is in_progress, this also advances it to testing (PR opened, awaiting CI). Idempotent and never forces a state it hasn't earned: todo, blocked, testing, failing, passing, and merged are left exactly as they are — only pr_url is updated.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.String()),
      pr_url: Type.String({ minLength: 1 }),
    }),
    execute: async ({ task_id, pr_url }, ctx) => {
      const taskId = resolveTaskId(task_id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const parsed = parsePrUrl(pr_url);
      if (!parsed) {
        return errResult(
          `Error: Could not parse PR url '${pr_url}'. Expected https://github.com/<owner>/<repo>/pull/<n> or <owner>/<repo>#<n>.`
        );
      }
      const result = await safe(async () => {
        const task = await repo.getTask(taskId);
        if (!task) throw new repo.RepoError(`Task ${taskId} not found`, 404);
        await repo.setTaskPr(taskId, parsed.canonical);
        // Only in_progress → testing is a real "PR just opened" advance.
        // - todo can't jump straight to testing anyway (TASK_TRANSITIONS
        //   requires todo → in_progress first) — leave it alone rather than
        //   fake a state it hasn't earned.
        // - blocked → testing IS a legal edge in TASK_TRANSITIONS, but a
        //   human/agent put it there on purpose; a PR link showing up must
        //   not silently un-block it.
        // - testing/failing/passing/merged already reflect real PR/CI state;
        //   re-affirming it here would be a lie at best, a race at worst.
        if (task.state === "in_progress") {
          await repo.transitionTask(taskId, {
            state: "testing",
            note: `PR opened: ${parsed.canonical}`,
          });
        }
        return task;
      });
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Task ${taskId} pr_url set to ${parsed.canonical}.`);
    },
  },

  {
    name: "delete_task",
    label: "Delete Task",
    description:
      "Delete a task. CASCADES to its notes, criteria, dependencies, and sessions. Refuses if the task has an active (non-terminal) agent run — cancel it with cancel_session first, since the cascade would delete a live run's row out from under it.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async ({ id }, _ctx) => {
      const existing = await repo.getTask(id);
      if (!existing) return errResult(`Error: Task ${id} not found`);
      // agent_sessions.taskId→tasks is ON DELETE CASCADE: deleting the task
      // while a run is live would vaporize that run's row mid-turn (worker's
      // next get(runId) throws, worktree leaks, no cancel handle). Refuse.
      const activeRuns = await runs.list({ taskId: id, activeOnly: true });
      if (activeRuns.length > 0) {
        return errResult(
          `Error: Task ${id} has ${activeRuns.length} active run(s) (${activeRuns
            .map((r) => `#${r.id}`)
            .join(", ")}). Cancel them with cancel_session before deleting the task.`
        );
      }
      await repo.deleteTask(id);
      return ok(`Deleted task ${id}.`);
    },
  },

  // ── Notes ──────────────────────────────────────────────

  {
    name: "add_note",
    label: "Add Note",
    description: "Append a note to a task. Use for non-obvious decisions, context, blockers.",
    parameters: Type.Object({
      body: Type.String({ minLength: 1 }),
      task_id: Type.Optional(Type.String()),
    }),
    execute: async ({ body, task_id }, ctx) => {
      const taskId = resolveTaskId(task_id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const result = await safe(() => repo.addNote(taskId, ctx.author, body));
      if (result && typeof result === "object" && "_error" in result)
        return errResult(`Error: ${(result as { _error: string })._error}`);
      return ok(`Note added to ${taskId}.`);
    },
  },

  {
    name: "list_notes",
    label: "List Notes",
    description: "List notes on a task in chronological order.",
    parameters: Type.Object({ task_id: Type.Optional(Type.String()) }),
    execute: async ({ task_id }, ctx) => {
      const taskId = resolveTaskId(task_id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const t = await repo.getTask(taskId);
      if (!t) return errResult(`Error: Task ${taskId} not found`);
      return jsonResult(
        t.notes.map((n) => ({
          id: n.id,
          author: n.author,
          body: n.body,
          created_at: n.createdAt.toISOString(),
        }))
      );
    },
  },

  // ── Acceptance criteria ────────────────────────────────

  {
    name: "list_criteria",
    label: "List Criteria",
    description: "List a task's acceptance criteria.",
    parameters: Type.Object({ task_id: Type.Optional(Type.String()) }),
    execute: async ({ task_id }, ctx) => {
      const taskId = resolveTaskId(task_id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const t = await repo.getTask(taskId);
      if (!t) return errResult(`Error: Task ${taskId} not found`);
      if (t.criteria.length === 0) return ok("No criteria.");
      return ok(t.criteria.map((c) => `${c.id}. [${c.done ? "x" : " "}] ${c.text}`).join("\n"));
    },
  },

  {
    name: "add_criterion",
    label: "Add Criterion",
    description: "Add an acceptance criterion to a task.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1 }),
      task_id: Type.Optional(Type.String()),
    }),
    execute: async ({ text, task_id }, ctx) => {
      const taskId = resolveTaskId(task_id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const result = await safe(() => repo.addCriterion(taskId, text));
      if (result && typeof result === "object" && "_error" in result)
        return errResult(`Error: ${(result as { _error: string })._error}`);
      return ok(`Added: ${text}`);
    },
  },

  {
    name: "check_criterion",
    label: "Check Criterion",
    description:
      "Mark an acceptance criterion done. Match by numeric id or substring of text.",
    parameters: Type.Object({
      criterion: Type.String({ minLength: 1 }),
      task_id: Type.Optional(Type.String()),
    }),
    execute: async ({ criterion, task_id }, ctx) => {
      const taskId = resolveTaskId(task_id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const target = await findCriterion(taskId, criterion);
      if (!target) return errResult(`Error: No criterion matching "${criterion}" on ${taskId}.`);
      await repo.updateCriterion(target.id, { done: true });
      return ok(`Checked: ${target.text}`);
    },
  },

  {
    name: "uncheck_criterion",
    label: "Uncheck Criterion",
    description: "Mark an acceptance criterion not-done.",
    parameters: Type.Object({
      criterion: Type.String({ minLength: 1 }),
      task_id: Type.Optional(Type.String()),
    }),
    execute: async ({ criterion, task_id }, ctx) => {
      const taskId = resolveTaskId(task_id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const target = await findCriterion(taskId, criterion);
      if (!target) return errResult(`Error: No criterion matching "${criterion}" on ${taskId}.`);
      await repo.updateCriterion(target.id, { done: false });
      return ok(`Unchecked: ${target.text}`);
    },
  },

  {
    name: "update_criterion",
    label: "Update Criterion",
    description: "Edit a criterion's text or done state by criterion id.",
    parameters: Type.Object({
      criterion_id: Type.Integer(),
      text: Type.Optional(Type.String()),
      done: Type.Optional(Type.Boolean()),
    }),
    execute: async ({ criterion_id, text, done }, _ctx) => {
      const result = await safe(() => repo.updateCriterion(criterion_id, { text, done }));
      if (result && typeof result === "object" && "_error" in result)
        return errResult(`Error: ${(result as { _error: string })._error}`);
      return ok(`Criterion ${criterion_id} updated.`);
    },
  },

  {
    name: "delete_criterion",
    label: "Delete Criterion",
    description: "Delete a criterion by id.",
    parameters: Type.Object({ criterion_id: Type.Integer() }),
    execute: async ({ criterion_id }, _ctx) => {
      await repo.deleteCriterion(criterion_id);
      return ok(`Criterion ${criterion_id} deleted.`);
    },
  },

  // ── Attachments (images & artifacts) ──────────────────

  {
    name: "list_attachments",
    label: "List Attachments",
    description:
      "List images and artifacts attached to a task or plan. Defaults to your current task, then the scoped plan, when neither task_id nor plan_id is given. Returns metadata only — call get_attachment to read the bytes.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.String()),
      plan_id: Type.Optional(Type.String()),
    }),
    execute: async ({ task_id, plan_id }, ctx) => {
      const owner = resolveAttachmentOwner(task_id, plan_id, ctx);
      if (!owner) return errResult("Error: task_id or plan_id required");
      const list = await repo.listAttachments(owner);
      return jsonResult(list.map(summariseAttachment));
    },
  },

  {
    name: "get_attachment",
    label: "Get Attachment",
    description:
      "Fetch an attachment's content by numeric id. Images come back as a viewable image block; text-like artifacts (logs, json, source, svg) as decoded text; other binaries as metadata with a note to download them. Large blobs are truncated or summarised.",
    parameters: Type.Object({ id: Type.Integer() }),
    execute: async ({ id }, _ctx) => {
      const att = await repo.getAttachment(id);
      if (!att) return errResult(`Error: Attachment ${id} not found`);
      const header = `${att.filename} (${att.mimeType}, ${att.sizeBytes} bytes, attachment #${att.id})`;
      if (att.kind === "image") {
        if (att.sizeBytes > IMAGE_INLINE_MAX) {
          return ok(
            `${header}\n\nImage too large to inline (${att.sizeBytes} bytes > ${IMAGE_INLINE_MAX}). Download it from /api/attachments/${att.id}.`
          );
        }
        return {
          content: [
            { type: "text", text: header },
            { type: "image", data: att.content.toString("base64"), mimeType: att.mimeType },
          ],
        };
      }
      if (isTextualMime(att.mimeType)) {
        let text = att.content.toString("utf8");
        let suffix = "";
        if (text.length > TEXT_INLINE_MAX_CHARS) {
          text = text.slice(0, TEXT_INLINE_MAX_CHARS);
          suffix = `\n\n…(truncated at ${TEXT_INLINE_MAX_CHARS} chars; download the full file from /api/attachments/${att.id})`;
        }
        return ok(`${header}\n\n${text}${suffix}`);
      }
      return ok(
        `${header}\n\nBinary artifact — not inlined. Download it from /api/attachments/${att.id}.`
      );
    },
  },

  {
    name: "add_attachment",
    label: "Add Attachment",
    description:
      "Attach an artifact to a task or plan. Provide either `text` (UTF-8, e.g. a generated report) or `content_base64` (any bytes). Defaults to your current task, then the scoped plan, when neither task_id nor plan_id is given. mime_type defaults to text/plain for text and application/octet-stream for base64.",
    parameters: Type.Object({
      filename: Type.String({ minLength: 1 }),
      text: Type.Optional(Type.String()),
      content_base64: Type.Optional(Type.String()),
      mime_type: Type.Optional(Type.String()),
      task_id: Type.Optional(Type.String()),
      plan_id: Type.Optional(Type.String()),
    }),
    execute: async ({ filename, text, content_base64, mime_type, task_id, plan_id }, ctx) => {
      const owner = resolveAttachmentOwner(task_id, plan_id, ctx);
      if (!owner) return errResult("Error: task_id or plan_id required");
      if ((text == null) === (content_base64 == null)) {
        return errResult("Error: provide exactly one of `text` or `content_base64`");
      }
      const content =
        text != null ? Buffer.from(text, "utf8") : Buffer.from(content_base64!, "base64");
      const mimeType =
        mime_type?.trim() ||
        (text != null ? "text/plain" : "application/octet-stream");
      const result = await safe(() =>
        repo.addAttachment({
          planId: owner.planId ?? null,
          taskId: owner.taskId ?? null,
          filename,
          mimeType,
          content,
          author: ctx.author,
        })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(
        `Attached #${result.id} ${result.filename} (${result.kind}, ${result.sizeBytes} bytes) to ${result.taskId ?? result.planId}.`
      );
    },
  },

  {
    name: "delete_attachment",
    label: "Delete Attachment",
    description: "Delete an attachment by numeric id.",
    parameters: Type.Object({ id: Type.Integer() }),
    execute: async ({ id }, _ctx) => {
      const existing = await repo.getAttachmentMeta(id);
      if (!existing) return errResult(`Error: Attachment ${id} not found`);
      await repo.deleteAttachment(id);
      return ok(`Deleted attachment ${id}.`);
    },
  },

  // ── Agent sessions ─────────────────────────────────────

  {
    name: "list_sessions",
    label: "List Sessions",
    description: "List agent sessions. Filter by task_id or only-active.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.String()),
      active_only: Type.Optional(Type.Boolean()),
    }),
    execute: async ({ task_id, active_only }, _ctx) => {
      const all = active_only
        ? await agentLib.listActiveSessions(task_id)
        : await agentLib.listSessions(task_id);
      return jsonResult(all.map(summariseSession));
    },
  },

  {
    name: "get_session",
    label: "Get Session",
    description: "Get an agent session including its recent event tail.",
    parameters: Type.Object({
      session_id: Type.Integer(),
      tail: Type.Optional(Type.Integer()),
    }),
    execute: async ({ session_id, tail }, _ctx) => {
      const s = await agentLib.getSession(session_id);
      if (!s) return errResult(`Error: Session ${session_id} not found`);
      const events = await agentLib.getSessionEvents(session_id, 0, tail ?? 50);
      return jsonResult({
        ...summariseSession(s),
        recent_events: events.map((e) => ({
          id: e.id,
          type: e.type,
          created_at: e.createdAt.toISOString(),
          payload: e.payload,
        })),
      });
    },
  },

  {
    name: "start_session",
    label: "Start Session",
    description:
      "Kick off a background Claude agent to implement a task. Creates a worktree, runs the agent, opens a PR when done, and moves the task to review. Returns the session id immediately (non-blocking). To wait, call await_session; it parks your run and child events wake you later.",
    parameters: Type.Object({
      task_id: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String()),
      reasoning: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")], {
          description: "Reasoning level for the agent. Omit to use the persona's default.",
        })
      ),
      base_branch: Type.Optional(Type.String()),
    }),
    execute: async ({ task_id, model, reasoning, base_branch }, ctx) => {
      const userId = await resolveSpawnerUserId(ctx);
      const result = await safe(() =>
        agentLib.startSession({
          taskId: task_id,
          model,
          thinkingLevel: reasoning ?? null,
          baseBranch: base_branch,
          parentRunId: ctx.runId ?? null,
          userId,
        })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(
        `Started session #${result.id} on ${result.taskId} (model: ${result.model ?? "default"}).`
      );
    },
  },

  {
    name: "await_session",
    label: "Await Session",
    description:
      "Wait for an agent session without polling. If the session is already terminal, returns its status, outcome, review verdict (if any), PR url, error, and cost. Otherwise parks the caller and returns immediately; child.result/child.exception/child.cancelled/child.budget_exhausted events wake the caller when the child finishes. A timeout timer wakes the caller as a backstop.",
    parameters: Type.Object({
      session_id: Type.Integer(),
      timeout_seconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 7200,
          description: "Backstop wakeup delay in seconds. Default 1800, max 7200 (2h). The tool does not block for this duration.",
        })
      ),
    }),
    execute: async ({ session_id, timeout_seconds }, ctx) => {
      let run = await runs.get(session_id);
      if (!run) return errResult(`Error: Session ${session_id} not found`);
      if (isTerminalStatus(run.status)) {
        return jsonResult({
          session_id,
          status: run.status,
          outcome: run.outcome,
          verdict: parseReviewVerdict(run.outcome),
          pr_url: run.prUrl,
          error: run.error,
          total_cost_usd: run.totalCostUsd,
        });
      }

      if (!ctx.runId) {
        return jsonResult({
          session_id,
          status: run.status,
          waiting: false,
          message:
            "Session is still running. await_session only parks when called from inside a run.",
          pr_url: run.prUrl,
        });
      }

      const timeoutSeconds = timeout_seconds ?? 1800;
      const minutes = Math.max(
        TIMER_MIN_MINUTES,
        Math.min(TIMER_MAX_MINUTES, Math.ceil(timeoutSeconds / 60))
      );
      const timer = await createTimer({
        runId: ctx.runId,
        minutes,
        note: `await_session #${session_id} timeout`,
        correlationId: `await-session:${session_id}`,
      });
      // Park via the shared turn-effect writer (lib/run-state.ts) — the same
      // path the events.ts tools use — instead of a bespoke db.update. Keeps the
      // parking-contract column writes in exactly one place.
      const callerRunId = ctx.runId;
      await recordTurnEffect(
        (columns) => db.update(agentSessions).set(columns).where(eq(agentSessions.id, callerRunId)),
        { kind: "park", reason: "waiting" }
      );

      return jsonResult({
        session_id,
        status: run.status,
        waiting: true,
        caller_run_id: ctx.runId,
        wake_events: [
          "child.result",
          "child.exception",
          "child.cancelled",
          "child.budget_exhausted",
        ],
        timeout_timer_id: timer.ok ? timer.timerId : null,
        timeout_fire_at: timer.ok ? timer.fireAt.toISOString() : null,
        timer_error: timer.ok ? null : timer.error,
        message:
          "Caller parked. End your turn now; the run will wake when the child emits an event or the timeout fires.",
        pr_url: run.prUrl,
      });
    },
  },

  {
    name: "cancel_session",
    label: "Cancel Session",
    description: "Cancel a running agent session.",
    parameters: Type.Object({ session_id: Type.Integer() }),
    execute: async ({ session_id }, _ctx) => {
      const result = await safe(() => agentLib.cancelSession(session_id));
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Session #${result.id} status: ${result.status}.`);
    },
  },
];
