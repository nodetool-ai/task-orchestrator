// lib/orchestrator-tools.ts
//
// Shared registry of the 35 orchestrator tool definitions.
// The pi extension consumes this and registers each with the task_orch__ prefix.
// The MCP server consumes this directly (bare names).

import { Type, type TSchema } from "typebox";
import * as repo from "./repo";
import * as agentLib from "./agent";
import { PLAN_STATES, TASK_STATES, type PlanState, type TaskState } from "./types";
import type { TaskFull, PlanFull, AgentSessionFull, AttachmentMeta } from "./types";

// ──────────────────────────────────────────────────────
// Context and result types
// ──────────────────────────────────────────────────────

export interface OrchestratorToolContext {
  author: string;
  defaultTaskId?: string;
  defaultPlanId?: string;
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

const findCriterion = (taskId: string, needle: string) => {
  const task = repo.getTask(taskId);
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

function safe<T>(fn: () => T): T | { _error: string } {
  try {
    return fn();
  } catch (e) {
    if (e instanceof repo.RepoError) return { _error: e.message };
    return { _error: e instanceof Error ? e.message : String(e) };
  }
}

// ──────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────

function summarisePlan(p: PlanFull) {
  const progress = repo.planProgress(p.id);
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
        repo.listRepositories().map((r) => ({
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
      const r = repo.getRepository(id);
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
      const result = safe(() =>
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
      const result = safe(() =>
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
      const result = safe(() => repo.deleteRepository(id));
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
      const plans = repo.listPlans();
      const filtered = state ? plans.filter((p) => p.state === (state as PlanState)) : plans;
      return jsonResult(filtered.map(summarisePlan));
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
      const plan = repo.getPlan(planId);
      if (!plan) return errResult(`Error: Plan ${planId} not found`);
      const tasksInPlan = repo.listTasks({ planId }).map(summariseTask);
      return jsonResult({
        ...plan,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString(),
        progress: repo.planProgress(planId),
        tasks: tasksInPlan,
      });
    },
  },

  {
    name: "create_plan",
    label: "Create Plan",
    description:
      "Create a new plan across one or more repositories. Returns the plan id. Tasks under this plan must target one of the listed repositories. If repo_ids is omitted, defaults to [the default repo].",
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      body: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      state: Type.Optional(
        Type.Union(PLAN_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]])
      ),
      repo_ids: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (input, _ctx) => {
      const result = safe(() =>
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
      const result = safe(() =>
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
      const result = safe(() => repo.addPlanRepository(planId, repo_id));
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
      const result = safe(() => repo.removePlanRepository(planId, repo_id));
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
      const result = safe(() => repo.updatePlan(planId, { state: state as PlanState }));
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Plan ${result.id} → ${result.state}.`);
    },
  },

  {
    name: "delete_plan",
    label: "Delete Plan",
    description:
      "Delete a plan. CASCADES — destroys all tasks, criteria, notes, and sessions under it. Requires an explicit id (never defaulted) to avoid accidental destruction.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async ({ id }, _ctx) => {
      const existing = repo.getPlan(id);
      if (!existing) return errResult(`Error: Plan ${id} not found`);
      repo.deletePlan(id);
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
      const tasks = repo.listTasks({ state: state as TaskState | undefined, planId, assignee });
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
      const t = repo.getTask(taskId);
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
      const result = safe(() =>
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
      const result = safe(() =>
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
      "Change a task's state with optional note and assignee. Allowed: todo→in_progress/cancelled, in_progress→review/done/blocked/cancelled, review→in_progress/done/cancelled, blocked→in_progress/cancelled. Going to in_progress requires an assignee. Going to done requires all acceptance criteria checked.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      state: Type.Union(TASK_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
      assignee: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
    }),
    execute: async ({ id, state, assignee, note }, ctx) => {
      const taskId = resolveTaskId(id, ctx);
      if (!taskId) return errResult("Error: task id required");
      const result = safe(() =>
        repo.transitionTask(taskId, { state: state as TaskState, assignee, note })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Task ${result.id} → ${result.state}.`);
    },
  },

  {
    name: "delete_task",
    label: "Delete Task",
    description: "Delete a task. CASCADES to its notes, criteria, dependencies, and sessions.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async ({ id }, _ctx) => {
      const existing = repo.getTask(id);
      if (!existing) return errResult(`Error: Task ${id} not found`);
      repo.deleteTask(id);
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
      const result = safe(() => repo.addNote(taskId, ctx.author, body));
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
      const t = repo.getTask(taskId);
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
      const t = repo.getTask(taskId);
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
      const result = safe(() => repo.addCriterion(taskId, text));
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
      const target = findCriterion(taskId, criterion);
      if (!target) return errResult(`Error: No criterion matching "${criterion}" on ${taskId}.`);
      repo.updateCriterion(target.id, { done: true });
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
      const target = findCriterion(taskId, criterion);
      if (!target) return errResult(`Error: No criterion matching "${criterion}" on ${taskId}.`);
      repo.updateCriterion(target.id, { done: false });
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
      const result = safe(() => repo.updateCriterion(criterion_id, { text, done }));
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
      repo.deleteCriterion(criterion_id);
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
      const list = repo.listAttachments(owner);
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
      const att = repo.getAttachment(id);
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
      const result = safe(() =>
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
      const existing = repo.getAttachmentMeta(id);
      if (!existing) return errResult(`Error: Attachment ${id} not found`);
      repo.deleteAttachment(id);
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
        ? agentLib.listActiveSessions(task_id)
        : agentLib.listSessions(task_id);
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
      const s = agentLib.getSession(session_id);
      if (!s) return errResult(`Error: Session ${session_id} not found`);
      const events = agentLib.getSessionEvents(session_id, 0, tail ?? 50);
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
      "Kick off a background Claude agent to work on a task. Creates a worktree, runs the agent, opens a PR when done. Returns the session id.",
    parameters: Type.Object({
      task_id: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String()),
      base_branch: Type.Optional(Type.String()),
    }),
    execute: async ({ task_id, model, base_branch }, _ctx) => {
      const result = safe(() =>
        agentLib.startSession({ taskId: task_id, model, baseBranch: base_branch })
      );
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(
        `Started session #${result.id} on ${result.taskId} (model: ${result.model ?? "default"}).`
      );
    },
  },

  {
    name: "cancel_session",
    label: "Cancel Session",
    description: "Cancel a running agent session.",
    parameters: Type.Object({ session_id: Type.Integer() }),
    execute: async ({ session_id }, _ctx) => {
      const result = safe(() => agentLib.cancelSession(session_id));
      if ("_error" in result) return errResult(`Error: ${result._error}`);
      return ok(`Session #${result.id} status: ${result.status}.`);
    },
  },
];
