// SDK MCP server exposing the full orchestrator surface to Claude agents.
//
// Both the task agent (lib/agent.ts) and the chat agent (lib/chat.ts) mount
// this server. Tool names appear to the model as `mcp__task_orch__<name>`.
//
// Scope:
//   - `author`     — recorded on notes and state-transition events.
//   - `defaultTaskId` — optional; tools that act on a single task use this
//     when no `task_id` is supplied. The task agent passes its current task;
//     the chat agent leaves it undefined so every call carries an explicit id.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as repo from "./repo";
import * as agent from "./agent";
import { PLAN_STATES, TASK_STATES, type PlanState, type TaskState } from "./types";
import type { TaskFull, PlanFull, AgentSessionFull } from "./types";

export interface OrchestratorMcpOptions {
  author: string;
  defaultTaskId?: string;
}

// Helper: format a tool error without throwing (throwing kills the run).
function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

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

function safe<T>(fn: () => T): T | { _error: string } {
  try {
    return fn();
  } catch (e) {
    if (e instanceof repo.RepoError) return { _error: e.message };
    return { _error: e instanceof Error ? e.message : String(e) };
  }
}

export function createOrchestratorMcpServer(opts: OrchestratorMcpOptions) {
  const { author, defaultTaskId } = opts;

  // Resolve task_id from arg or default; null means caller must specify.
  const resolveTaskId = (provided: string | undefined): string | null => {
    if (provided && provided.trim()) return provided.trim();
    return defaultTaskId ?? null;
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

  return createSdkMcpServer({
    name: "task_orch",
    version: "2.0.0",
    tools: [
      // ──────────────────────────────────────────────────────
      // Repositories
      // ──────────────────────────────────────────────────────
      tool(
        "list_repositories",
        "List configured repositories. Each repository is a git checkout the orchestrator can drive (worktrees for sessions, cwd for chat agents).",
        {},
        async () => {
          return json(
            repo.listRepositories().map((r) => ({
              id: r.id,
              name: r.name,
              local_path: r.localPath,
              remote: r.remote,
              default_branch: r.defaultBranch,
              description: r.description,
            }))
          );
        }
      ),
      tool(
        "get_repository",
        "Get a repository's full details.",
        { id: z.string().min(1) },
        async ({ id }) => {
          const r = repo.getRepository(id);
          if (!r) return err(`Repository ${id} not found`);
          return json({
            ...r,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          });
        }
      ),
      tool(
        "create_repository",
        "Register a new repository. local_path should point at a git checkout the service user can read and (for agent sessions) write to.",
        {
          name: z.string().min(1),
          local_path: z.string().optional(),
          remote: z.string().optional(),
          default_branch: z.string().optional(),
          description: z.string().optional(),
        },
        async (input) => {
          const result = safe(() =>
            repo.createRepository({
              name: input.name,
              localPath: input.local_path,
              remote: input.remote,
              defaultBranch: input.default_branch,
              description: input.description,
            })
          );
          if ("_error" in result) return err(result._error);
          return ok(`Created repository ${result.id}: ${result.name}`);
        }
      ),
      tool(
        "update_repository",
        "Patch a repository's name, local_path, remote, default_branch, or description.",
        {
          id: z.string().min(1),
          name: z.string().optional(),
          local_path: z.string().nullable().optional(),
          remote: z.string().nullable().optional(),
          default_branch: z.string().optional(),
          description: z.string().optional(),
        },
        async ({ id, ...patch }) => {
          const result = safe(() =>
            repo.updateRepository(id, {
              name: patch.name,
              localPath: patch.local_path ?? undefined,
              remote: patch.remote ?? undefined,
              defaultBranch: patch.default_branch,
              description: patch.description,
            })
          );
          if ("_error" in result) return err(result._error);
          return ok(`Updated repository ${result.id}.`);
        }
      ),
      tool(
        "delete_repository",
        "Delete a repository. Blocked if any plans or chats still reference it; reassign them first.",
        { id: z.string().min(1) },
        async ({ id }) => {
          const result = safe(() => repo.deleteRepository(id));
          if (result && typeof result === "object" && "_error" in result)
            return err((result as { _error: string })._error);
          return ok(`Deleted repository ${id}.`);
        }
      ),

      // ──────────────────────────────────────────────────────
      // Plans
      // ──────────────────────────────────────────────────────
      tool(
        "list_plans",
        "List all plans. Optionally filter by state.",
        { state: z.enum(PLAN_STATES).optional() },
        async ({ state }) => {
          const plans = repo.listPlans();
          const filtered = state ? plans.filter((p) => p.state === state) : plans;
          return json(filtered.map(summarisePlan));
        }
      ),
      tool(
        "get_plan",
        "Get full details for a plan including its tasks (summarized).",
        { id: z.string().min(1) },
        async ({ id }) => {
          const plan = repo.getPlan(id);
          if (!plan) return err(`Plan ${id} not found`);
          const tasksInPlan = repo.listTasks({ planId: id }).map(summariseTask);
          return json({
            ...plan,
            createdAt: plan.createdAt.toISOString(),
            updatedAt: plan.updatedAt.toISOString(),
            progress: repo.planProgress(id),
            tasks: tasksInPlan,
          });
        }
      ),
      tool(
        "create_plan",
        "Create a new plan across one or more repositories. Returns the plan id. Tasks under this plan must target one of the listed repositories. If repo_ids is omitted, defaults to [the default repo].",
        {
          title: z.string().min(1),
          body: z.string().optional(),
          owner: z.string().optional(),
          tags: z.array(z.string()).optional(),
          state: z.enum(PLAN_STATES).optional(),
          repo_ids: z.array(z.string()).optional(),
        },
        async (input) => {
          const result = safe(() =>
            repo.createPlan({
              title: input.title,
              body: input.body,
              owner: input.owner,
              tags: input.tags,
              state: input.state,
              repoIds: input.repo_ids,
            })
          );
          if ("_error" in result) return err(result._error);
          return ok(`Created plan ${result.id}: ${result.title} (${result.repos.length} repo${result.repos.length === 1 ? "" : "s"})`);
        }
      ),
      tool(
        "update_plan",
        "Patch a plan's title, body, owner, tags, or entire repository set (repo_ids replaces all). Use add_plan_repository/remove_plan_repository for granular changes. Use transition_plan to change state.",
        {
          id: z.string().min(1),
          title: z.string().optional(),
          body: z.string().optional(),
          owner: z.string().nullable().optional(),
          tags: z.array(z.string()).optional(),
          repo_ids: z.array(z.string()).optional(),
        },
        async ({ id, ...patch }) => {
          const result = safe(() =>
            repo.updatePlan(id, {
              title: patch.title,
              body: patch.body,
              owner: patch.owner ?? undefined,
              tags: patch.tags,
              repoIds: patch.repo_ids,
            })
          );
          if ("_error" in result) return err(result._error);
          return ok(`Updated plan ${result.id} (state: ${result.state}, ${result.repos.length} repo${result.repos.length === 1 ? "" : "s"}).`);
        }
      ),
      tool(
        "add_plan_repository",
        "Attach an additional repository to a plan. The new repo becomes the last in the plan's repo list. No-op if already attached.",
        { plan_id: z.string().min(1), repo_id: z.string().min(1) },
        async ({ plan_id, repo_id }) => {
          const result = safe(() => repo.addPlanRepository(plan_id, repo_id));
          if ("_error" in result) return err(result._error);
          return ok(`Plan ${result.id} now spans ${result.repos.map((r) => r.id).join(", ")}.`);
        }
      ),
      tool(
        "remove_plan_repository",
        "Detach a repository from a plan. Any tasks pinned to it are unset and will refuse to start until reassigned.",
        { plan_id: z.string().min(1), repo_id: z.string().min(1) },
        async ({ plan_id, repo_id }) => {
          const result = safe(() => repo.removePlanRepository(plan_id, repo_id));
          if ("_error" in result) return err(result._error);
          return ok(`Plan ${result.id} now spans ${result.repos.map((r) => r.id).join(", ") || "(no repos)"}.`);
        }
      ),
      tool(
        "transition_plan",
        "Change a plan's state. Allowed transitions: draft→proposed/accepted/cancelled, proposed→accepted/cancelled, accepted→done/cancelled.",
        { id: z.string().min(1), state: z.enum(PLAN_STATES) },
        async ({ id, state }) => {
          const result = safe(() => repo.updatePlan(id, { state: state as PlanState }));
          if ("_error" in result) return err(result._error);
          return ok(`Plan ${result.id} → ${result.state}.`);
        }
      ),
      tool(
        "delete_plan",
        "Delete a plan. CASCADES — destroys all tasks, criteria, notes, and sessions under it.",
        { id: z.string().min(1) },
        async ({ id }) => {
          const existing = repo.getPlan(id);
          if (!existing) return err(`Plan ${id} not found`);
          repo.deletePlan(id);
          return ok(`Deleted plan ${id}.`);
        }
      ),

      // ──────────────────────────────────────────────────────
      // Tasks
      // ──────────────────────────────────────────────────────
      tool(
        "list_tasks",
        "List tasks. Filter by state, plan_id, and/or assignee.",
        {
          state: z.enum(TASK_STATES).optional(),
          plan_id: z.string().optional(),
          assignee: z.string().optional(),
        },
        async ({ state, plan_id, assignee }) => {
          const tasks = repo.listTasks({ state, planId: plan_id, assignee });
          return json(tasks.map(summariseTask));
        }
      ),
      tool(
        "get_task",
        "Get full task details (body, criteria, notes, deps). Defaults to your current task if no id given.",
        { id: z.string().optional() },
        async ({ id }) => {
          const taskId = resolveTaskId(id);
          if (!taskId) return err("task id required (no default task in this session)");
          const t = repo.getTask(taskId);
          if (!t) return err(`Task ${taskId} not found`);
          return json({
            ...t,
            createdAt: t.createdAt.toISOString(),
            updatedAt: t.updatedAt.toISOString(),
            notes: t.notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
          });
        }
      ),
      tool(
        "create_task",
        "Create a new task under a plan. The task targets one of the plan's repositories: if the plan has exactly one repo it's inherited, otherwise repo_id is required and must be in the plan's set.",
        {
          plan_id: z.string().min(1),
          title: z.string().min(1),
          body: z.string().optional(),
          assignee: z.string().nullable().optional(),
          estimate: z.string().nullable().optional(),
          tags: z.array(z.string()).optional(),
          dependencies: z.array(z.string()).optional(),
          criteria: z.array(z.string()).optional(),
          repo_id: z.string().optional(),
        },
        async (input) => {
          const result = safe(() =>
            repo.createTask({
              planId: input.plan_id,
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
          if ("_error" in result) return err(result._error);
          return ok(`Created task ${result.id}: ${result.title}${result.repoId ? ` → ${result.repoId}` : ""}`);
        }
      ),
      tool(
        "update_task",
        "Patch a task's fields (title, body, assignee, estimate, tags, dependencies, repo_id). The new repo_id must be one of the plan's repositories. Use transition_task to change state.",
        {
          id: z.string().optional(),
          title: z.string().optional(),
          body: z.string().optional(),
          assignee: z.string().nullable().optional(),
          estimate: z.string().nullable().optional(),
          tags: z.array(z.string()).optional(),
          dependencies: z.array(z.string()).optional(),
          repo_id: z.string().nullable().optional(),
        },
        async ({ id, ...patch }) => {
          const taskId = resolveTaskId(id);
          if (!taskId) return err("task id required");
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
          if ("_error" in result) return err(result._error);
          return ok(`Updated task ${result.id}.`);
        }
      ),
      tool(
        "transition_task",
        "Change a task's state with optional note and assignee. Allowed: todo→in_progress/cancelled, in_progress→review/done/blocked/cancelled, review→in_progress/done/cancelled, blocked→in_progress/cancelled. Going to in_progress requires an assignee. Going to done requires all acceptance criteria checked.",
        {
          id: z.string().optional(),
          state: z.enum(TASK_STATES),
          assignee: z.string().optional(),
          note: z.string().optional(),
        },
        async ({ id, state, assignee, note }) => {
          const taskId = resolveTaskId(id);
          if (!taskId) return err("task id required");
          const result = safe(() =>
            repo.transitionTask(taskId, { state: state as TaskState, assignee, note })
          );
          if ("_error" in result) return err(result._error);
          return ok(`Task ${result.id} → ${result.state}.`);
        }
      ),
      tool(
        "delete_task",
        "Delete a task. CASCADES to its notes, criteria, dependencies, and sessions.",
        { id: z.string().min(1) },
        async ({ id }) => {
          const existing = repo.getTask(id);
          if (!existing) return err(`Task ${id} not found`);
          repo.deleteTask(id);
          return ok(`Deleted task ${id}.`);
        }
      ),

      // ──────────────────────────────────────────────────────
      // Notes
      // ──────────────────────────────────────────────────────
      tool(
        "add_note",
        "Append a note to a task. Use for non-obvious decisions, context, blockers.",
        { body: z.string().min(1), task_id: z.string().optional() },
        async ({ body, task_id }) => {
          const taskId = resolveTaskId(task_id);
          if (!taskId) return err("task id required");
          const result = safe(() => repo.addNote(taskId, author, body));
          if (result && typeof result === "object" && "_error" in result)
            return err((result as { _error: string })._error);
          return ok(`Note added to ${taskId}.`);
        }
      ),
      tool(
        "list_notes",
        "List notes on a task in chronological order.",
        { task_id: z.string().optional() },
        async ({ task_id }) => {
          const taskId = resolveTaskId(task_id);
          if (!taskId) return err("task id required");
          const t = repo.getTask(taskId);
          if (!t) return err(`Task ${taskId} not found`);
          return json(
            t.notes.map((n) => ({
              id: n.id,
              author: n.author,
              body: n.body,
              created_at: n.createdAt.toISOString(),
            }))
          );
        }
      ),

      // ──────────────────────────────────────────────────────
      // Acceptance criteria
      // ──────────────────────────────────────────────────────
      tool(
        "list_criteria",
        "List a task's acceptance criteria.",
        { task_id: z.string().optional() },
        async ({ task_id }) => {
          const taskId = resolveTaskId(task_id);
          if (!taskId) return err("task id required");
          const t = repo.getTask(taskId);
          if (!t) return err(`Task ${taskId} not found`);
          if (t.criteria.length === 0) return ok("No criteria.");
          return ok(t.criteria.map((c) => `${c.id}. [${c.done ? "x" : " "}] ${c.text}`).join("\n"));
        }
      ),
      tool(
        "add_criterion",
        "Add an acceptance criterion to a task.",
        { text: z.string().min(1), task_id: z.string().optional() },
        async ({ text, task_id }) => {
          const taskId = resolveTaskId(task_id);
          if (!taskId) return err("task id required");
          const result = safe(() => repo.addCriterion(taskId, text));
          if (result && typeof result === "object" && "_error" in result)
            return err((result as { _error: string })._error);
          return ok(`Added: ${text}`);
        }
      ),
      tool(
        "check_criterion",
        "Mark an acceptance criterion done. Match by numeric id or substring of text.",
        { criterion: z.string().min(1), task_id: z.string().optional() },
        async ({ criterion, task_id }) => {
          const taskId = resolveTaskId(task_id);
          if (!taskId) return err("task id required");
          const target = findCriterion(taskId, criterion);
          if (!target) return err(`No criterion matching "${criterion}" on ${taskId}.`);
          repo.updateCriterion(target.id, { done: true });
          return ok(`Checked: ${target.text}`);
        }
      ),
      tool(
        "uncheck_criterion",
        "Mark an acceptance criterion not-done.",
        { criterion: z.string().min(1), task_id: z.string().optional() },
        async ({ criterion, task_id }) => {
          const taskId = resolveTaskId(task_id);
          if (!taskId) return err("task id required");
          const target = findCriterion(taskId, criterion);
          if (!target) return err(`No criterion matching "${criterion}" on ${taskId}.`);
          repo.updateCriterion(target.id, { done: false });
          return ok(`Unchecked: ${target.text}`);
        }
      ),
      tool(
        "update_criterion",
        "Edit a criterion's text or done state by criterion id.",
        {
          criterion_id: z.number().int(),
          text: z.string().optional(),
          done: z.boolean().optional(),
        },
        async ({ criterion_id, text, done }) => {
          const result = safe(() => repo.updateCriterion(criterion_id, { text, done }));
          if (result && typeof result === "object" && "_error" in result)
            return err((result as { _error: string })._error);
          return ok(`Criterion ${criterion_id} updated.`);
        }
      ),
      tool(
        "delete_criterion",
        "Delete a criterion by id.",
        { criterion_id: z.number().int() },
        async ({ criterion_id }) => {
          repo.deleteCriterion(criterion_id);
          return ok(`Criterion ${criterion_id} deleted.`);
        }
      ),

      // ──────────────────────────────────────────────────────
      // Agent sessions
      // ──────────────────────────────────────────────────────
      tool(
        "list_sessions",
        "List agent sessions. Filter by task_id or only-active.",
        { task_id: z.string().optional(), active_only: z.boolean().optional() },
        async ({ task_id, active_only }) => {
          const all = active_only ? agent.listActiveSessions(task_id) : agent.listSessions(task_id);
          return json(all.map(summariseSession));
        }
      ),
      tool(
        "get_session",
        "Get an agent session including its recent event tail.",
        { session_id: z.number().int(), tail: z.number().int().optional() },
        async ({ session_id, tail }) => {
          const s = agent.getSession(session_id);
          if (!s) return err(`Session ${session_id} not found`);
          const events = agent.getSessionEvents(session_id, 0, tail ?? 50);
          return json({
            ...summariseSession(s),
            recent_events: events.map((e) => ({
              id: e.id,
              type: e.type,
              created_at: e.createdAt.toISOString(),
              payload: e.payload,
            })),
          });
        }
      ),
      tool(
        "start_session",
        "Kick off a background Claude agent to work on a task. Creates a worktree, runs the agent, opens a PR when done. Returns the session id.",
        {
          task_id: z.string().min(1),
          model: z.string().optional(),
          base_branch: z.string().optional(),
        },
        async ({ task_id, model, base_branch }) => {
          const result = safe(() =>
            agent.startSession({ taskId: task_id, model, baseBranch: base_branch })
          );
          if ("_error" in result) return err(result._error);
          return ok(`Started session #${result.id} on ${result.taskId} (model: ${result.model ?? "default"}).`);
        }
      ),
      tool(
        "cancel_session",
        "Cancel a running agent session.",
        { session_id: z.number().int() },
        async ({ session_id }) => {
          const result = safe(() => agent.cancelSession(session_id));
          if ("_error" in result) return err(result._error);
          return ok(`Session #${result.id} status: ${result.status}.`);
        }
      ),
    ],
  });
}

// Back-compat wrapper for lib/agent.ts — task-scoped agents get the same
// surface but with their current task as the default for task-id args.
export function createTaskMcpServer(taskId: string, author: string) {
  return createOrchestratorMcpServer({ author, defaultTaskId: taskId });
}
