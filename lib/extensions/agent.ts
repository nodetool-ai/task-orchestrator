// lib/extensions/agent.ts
//
// Orchestrator extension: pi-side replacement for lib/agent-mcp.ts. Tools are
// flat-namespaced as task_orch__<name>. Helpers come over verbatim.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as repo from "../repo";
import * as agentLib from "../agent";
import { PLAN_STATES, TASK_STATES, type PlanState, type TaskState } from "../types";
import type { TaskFull, PlanFull, AgentSessionFull } from "../types";
import type { ExtensionFactory } from "./types";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const errResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
  isError: true,
});
const jsonResult = (value: unknown) =>
  ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: undefined });

export interface OrchestratorExtensionOptions {
  author: string;
  defaultTaskId?: string;
}

export const orchestratorExtension =
  (opts: OrchestratorExtensionOptions): ExtensionFactory =>
  (pi: ExtensionAPI) => {
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

    // ──────────────────────────────────────────────────────
    // Repositories
    // ──────────────────────────────────────────────────────

    pi.registerTool({
      name: "task_orch__list_repositories",
      label: "List Repositories",
      description:
        "List configured repositories. Each repository is a git checkout the orchestrator can drive (worktrees for sessions, cwd for chat agents).",
      parameters: Type.Object({}),
      execute: async (_id, _params) => {
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
    });

    pi.registerTool({
      name: "task_orch__get_repository",
      label: "Get Repository",
      description: "Get a repository's full details.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      execute: async (_id, { id }) => {
        const r = repo.getRepository(id);
        if (!r) return errResult(`Error: Repository ${id} not found`);
        return jsonResult({
          ...r,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        });
      },
    });

    pi.registerTool({
      name: "task_orch__create_repository",
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
      execute: async (_id, input) => {
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
    });

    pi.registerTool({
      name: "task_orch__update_repository",
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
      execute: async (_id, { id, ...patch }) => {
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
    });

    pi.registerTool({
      name: "task_orch__delete_repository",
      label: "Delete Repository",
      description:
        "Delete a repository. Blocked if any plans or chats still reference it; reassign them first.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      execute: async (_id, { id }) => {
        const result = safe(() => repo.deleteRepository(id));
        if (result && typeof result === "object" && "_error" in result)
          return errResult(`Error: ${(result as { _error: string })._error}`);
        return ok(`Deleted repository ${id}.`);
      },
    });

    // ──────────────────────────────────────────────────────
    // Plans
    // ──────────────────────────────────────────────────────

    pi.registerTool({
      name: "task_orch__list_plans",
      label: "List Plans",
      description: "List all plans. Optionally filter by state.",
      parameters: Type.Object({
        state: Type.Optional(
          Type.Union(PLAN_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]])
        ),
      }),
      execute: async (_id, { state }) => {
        const plans = repo.listPlans();
        const filtered = state ? plans.filter((p) => p.state === (state as PlanState)) : plans;
        return jsonResult(filtered.map(summarisePlan));
      },
    });

    pi.registerTool({
      name: "task_orch__get_plan",
      label: "Get Plan",
      description: "Get full details for a plan including its tasks (summarized).",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      execute: async (_id, { id }) => {
        const plan = repo.getPlan(id);
        if (!plan) return errResult(`Error: Plan ${id} not found`);
        const tasksInPlan = repo.listTasks({ planId: id }).map(summariseTask);
        return jsonResult({
          ...plan,
          createdAt: plan.createdAt.toISOString(),
          updatedAt: plan.updatedAt.toISOString(),
          progress: repo.planProgress(id),
          tasks: tasksInPlan,
        });
      },
    });

    pi.registerTool({
      name: "task_orch__create_plan",
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
      execute: async (_id, input) => {
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
    });

    pi.registerTool({
      name: "task_orch__update_plan",
      label: "Update Plan",
      description:
        "Patch a plan's title, body, owner, tags, or entire repository set (repo_ids replaces all). Use add_plan_repository/remove_plan_repository for granular changes. Use transition_plan to change state.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        owner: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        repo_ids: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (_id, { id, ...patch }) => {
        const result = safe(() =>
          repo.updatePlan(id, {
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
    });

    pi.registerTool({
      name: "task_orch__add_plan_repository",
      label: "Add Plan Repository",
      description:
        "Attach an additional repository to a plan. The new repo becomes the last in the plan's repo list. No-op if already attached.",
      parameters: Type.Object({
        plan_id: Type.String({ minLength: 1 }),
        repo_id: Type.String({ minLength: 1 }),
      }),
      execute: async (_id, { plan_id, repo_id }) => {
        const result = safe(() => repo.addPlanRepository(plan_id, repo_id));
        if ("_error" in result) return errResult(`Error: ${result._error}`);
        return ok(`Plan ${result.id} now spans ${result.repos.map((r) => r.id).join(", ")}.`);
      },
    });

    pi.registerTool({
      name: "task_orch__remove_plan_repository",
      label: "Remove Plan Repository",
      description:
        "Detach a repository from a plan. Any tasks pinned to it are unset and will refuse to start until reassigned.",
      parameters: Type.Object({
        plan_id: Type.String({ minLength: 1 }),
        repo_id: Type.String({ minLength: 1 }),
      }),
      execute: async (_id, { plan_id, repo_id }) => {
        const result = safe(() => repo.removePlanRepository(plan_id, repo_id));
        if ("_error" in result) return errResult(`Error: ${result._error}`);
        return ok(
          `Plan ${result.id} now spans ${result.repos.map((r) => r.id).join(", ") || "(no repos)"}.`
        );
      },
    });

    pi.registerTool({
      name: "task_orch__transition_plan",
      label: "Transition Plan",
      description:
        "Change a plan's state. Allowed transitions: draft→proposed/accepted/cancelled, proposed→accepted/cancelled, accepted→done/cancelled.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
        state: Type.Union(PLAN_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
      }),
      execute: async (_id, { id, state }) => {
        const result = safe(() => repo.updatePlan(id, { state: state as PlanState }));
        if ("_error" in result) return errResult(`Error: ${result._error}`);
        return ok(`Plan ${result.id} → ${result.state}.`);
      },
    });

    pi.registerTool({
      name: "task_orch__delete_plan",
      label: "Delete Plan",
      description:
        "Delete a plan. CASCADES — destroys all tasks, criteria, notes, and sessions under it.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      execute: async (_id, { id }) => {
        const existing = repo.getPlan(id);
        if (!existing) return errResult(`Error: Plan ${id} not found`);
        repo.deletePlan(id);
        return ok(`Deleted plan ${id}.`);
      },
    });

    // ──────────────────────────────────────────────────────
    // Tasks
    // ──────────────────────────────────────────────────────

    pi.registerTool({
      name: "task_orch__list_tasks",
      label: "List Tasks",
      description: "List tasks. Filter by state, plan_id, and/or assignee.",
      parameters: Type.Object({
        state: Type.Optional(
          Type.Union(TASK_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]])
        ),
        plan_id: Type.Optional(Type.String()),
        assignee: Type.Optional(Type.String()),
      }),
      execute: async (_id, { state, plan_id, assignee }) => {
        const tasks = repo.listTasks({ state: state as TaskState | undefined, planId: plan_id, assignee });
        return jsonResult(tasks.map(summariseTask));
      },
    });

    pi.registerTool({
      name: "task_orch__get_task",
      label: "Get Task",
      description:
        "Get full task details (body, criteria, notes, deps). Defaults to your current task if no id given.",
      parameters: Type.Object({ id: Type.Optional(Type.String()) }),
      execute: async (_id, { id }) => {
        const taskId = resolveTaskId(id);
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
    });

    pi.registerTool({
      name: "task_orch__create_task",
      label: "Create Task",
      description:
        "Create a new task under a plan. The task targets one of the plan's repositories: if the plan has exactly one repo it's inherited, otherwise repo_id is required and must be in the plan's set.",
      parameters: Type.Object({
        plan_id: Type.String({ minLength: 1 }),
        title: Type.String({ minLength: 1 }),
        body: Type.Optional(Type.String()),
        assignee: Type.Optional(Type.String()),
        estimate: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        dependencies: Type.Optional(Type.Array(Type.String())),
        criteria: Type.Optional(Type.Array(Type.String())),
        repo_id: Type.Optional(Type.String()),
      }),
      execute: async (_id, input) => {
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
        if ("_error" in result) return errResult(`Error: ${result._error}`);
        return ok(
          `Created task ${result.id}: ${result.title}${result.repoId ? ` → ${result.repoId}` : ""}`
        );
      },
    });

    pi.registerTool({
      name: "task_orch__update_task",
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
      execute: async (_id, { id, ...patch }) => {
        const taskId = resolveTaskId(id);
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
    });

    pi.registerTool({
      name: "task_orch__transition_task",
      label: "Transition Task",
      description:
        "Change a task's state with optional note and assignee. Allowed: todo→in_progress/cancelled, in_progress→review/done/blocked/cancelled, review→in_progress/done/cancelled, blocked→in_progress/cancelled. Going to in_progress requires an assignee. Going to done requires all acceptance criteria checked.",
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        state: Type.Union(TASK_STATES.map((s) => Type.Literal(s)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
        assignee: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
      }),
      execute: async (_id, { id, state, assignee, note }) => {
        const taskId = resolveTaskId(id);
        if (!taskId) return errResult("Error: task id required");
        const result = safe(() =>
          repo.transitionTask(taskId, { state: state as TaskState, assignee, note })
        );
        if ("_error" in result) return errResult(`Error: ${result._error}`);
        return ok(`Task ${result.id} → ${result.state}.`);
      },
    });

    pi.registerTool({
      name: "task_orch__delete_task",
      label: "Delete Task",
      description: "Delete a task. CASCADES to its notes, criteria, dependencies, and sessions.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      execute: async (_id, { id }) => {
        const existing = repo.getTask(id);
        if (!existing) return errResult(`Error: Task ${id} not found`);
        repo.deleteTask(id);
        return ok(`Deleted task ${id}.`);
      },
    });

    // ──────────────────────────────────────────────────────
    // Notes
    // ──────────────────────────────────────────────────────

    pi.registerTool({
      name: "task_orch__add_note",
      label: "Add Note",
      description: "Append a note to a task. Use for non-obvious decisions, context, blockers.",
      parameters: Type.Object({
        body: Type.String({ minLength: 1 }),
        task_id: Type.Optional(Type.String()),
      }),
      execute: async (_id, { body, task_id }) => {
        const taskId = resolveTaskId(task_id);
        if (!taskId) return errResult("Error: task id required");
        const result = safe(() => repo.addNote(taskId, author, body));
        if (result && typeof result === "object" && "_error" in result)
          return errResult(`Error: ${(result as { _error: string })._error}`);
        return ok(`Note added to ${taskId}.`);
      },
    });

    pi.registerTool({
      name: "task_orch__list_notes",
      label: "List Notes",
      description: "List notes on a task in chronological order.",
      parameters: Type.Object({ task_id: Type.Optional(Type.String()) }),
      execute: async (_id, { task_id }) => {
        const taskId = resolveTaskId(task_id);
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
    });

    // ──────────────────────────────────────────────────────
    // Acceptance criteria
    // ──────────────────────────────────────────────────────

    pi.registerTool({
      name: "task_orch__list_criteria",
      label: "List Criteria",
      description: "List a task's acceptance criteria.",
      parameters: Type.Object({ task_id: Type.Optional(Type.String()) }),
      execute: async (_id, { task_id }) => {
        const taskId = resolveTaskId(task_id);
        if (!taskId) return errResult("Error: task id required");
        const t = repo.getTask(taskId);
        if (!t) return errResult(`Error: Task ${taskId} not found`);
        if (t.criteria.length === 0) return ok("No criteria.");
        return ok(t.criteria.map((c) => `${c.id}. [${c.done ? "x" : " "}] ${c.text}`).join("\n"));
      },
    });

    pi.registerTool({
      name: "task_orch__add_criterion",
      label: "Add Criterion",
      description: "Add an acceptance criterion to a task.",
      parameters: Type.Object({
        text: Type.String({ minLength: 1 }),
        task_id: Type.Optional(Type.String()),
      }),
      execute: async (_id, { text, task_id }) => {
        const taskId = resolveTaskId(task_id);
        if (!taskId) return errResult("Error: task id required");
        const result = safe(() => repo.addCriterion(taskId, text));
        if (result && typeof result === "object" && "_error" in result)
          return errResult(`Error: ${(result as { _error: string })._error}`);
        return ok(`Added: ${text}`);
      },
    });

    pi.registerTool({
      name: "task_orch__check_criterion",
      label: "Check Criterion",
      description:
        "Mark an acceptance criterion done. Match by numeric id or substring of text.",
      parameters: Type.Object({
        criterion: Type.String({ minLength: 1 }),
        task_id: Type.Optional(Type.String()),
      }),
      execute: async (_id, { criterion, task_id }) => {
        const taskId = resolveTaskId(task_id);
        if (!taskId) return errResult("Error: task id required");
        const target = findCriterion(taskId, criterion);
        if (!target) return errResult(`Error: No criterion matching "${criterion}" on ${taskId}.`);
        repo.updateCriterion(target.id, { done: true });
        return ok(`Checked: ${target.text}`);
      },
    });

    pi.registerTool({
      name: "task_orch__uncheck_criterion",
      label: "Uncheck Criterion",
      description: "Mark an acceptance criterion not-done.",
      parameters: Type.Object({
        criterion: Type.String({ minLength: 1 }),
        task_id: Type.Optional(Type.String()),
      }),
      execute: async (_id, { criterion, task_id }) => {
        const taskId = resolveTaskId(task_id);
        if (!taskId) return errResult("Error: task id required");
        const target = findCriterion(taskId, criterion);
        if (!target) return errResult(`Error: No criterion matching "${criterion}" on ${taskId}.`);
        repo.updateCriterion(target.id, { done: false });
        return ok(`Unchecked: ${target.text}`);
      },
    });

    pi.registerTool({
      name: "task_orch__update_criterion",
      label: "Update Criterion",
      description: "Edit a criterion's text or done state by criterion id.",
      parameters: Type.Object({
        criterion_id: Type.Integer(),
        text: Type.Optional(Type.String()),
        done: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, { criterion_id, text, done }) => {
        const result = safe(() => repo.updateCriterion(criterion_id, { text, done }));
        if (result && typeof result === "object" && "_error" in result)
          return errResult(`Error: ${(result as { _error: string })._error}`);
        return ok(`Criterion ${criterion_id} updated.`);
      },
    });

    pi.registerTool({
      name: "task_orch__delete_criterion",
      label: "Delete Criterion",
      description: "Delete a criterion by id.",
      parameters: Type.Object({ criterion_id: Type.Integer() }),
      execute: async (_id, { criterion_id }) => {
        repo.deleteCriterion(criterion_id);
        return ok(`Criterion ${criterion_id} deleted.`);
      },
    });

    // ──────────────────────────────────────────────────────
    // Agent sessions
    // ──────────────────────────────────────────────────────

    pi.registerTool({
      name: "task_orch__list_sessions",
      label: "List Sessions",
      description: "List agent sessions. Filter by task_id or only-active.",
      parameters: Type.Object({
        task_id: Type.Optional(Type.String()),
        active_only: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, { task_id, active_only }) => {
        const all = active_only
          ? agentLib.listActiveSessions(task_id)
          : agentLib.listSessions(task_id);
        return jsonResult(all.map(summariseSession));
      },
    });

    pi.registerTool({
      name: "task_orch__get_session",
      label: "Get Session",
      description: "Get an agent session including its recent event tail.",
      parameters: Type.Object({
        session_id: Type.Integer(),
        tail: Type.Optional(Type.Integer()),
      }),
      execute: async (_id, { session_id, tail }) => {
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
    });

    pi.registerTool({
      name: "task_orch__start_session",
      label: "Start Session",
      description:
        "Kick off a background Claude agent to work on a task. Creates a worktree, runs the agent, opens a PR when done. Returns the session id.",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1 }),
        model: Type.Optional(Type.String()),
        base_branch: Type.Optional(Type.String()),
      }),
      execute: async (_id, { task_id, model, base_branch }) => {
        const result = safe(() =>
          agentLib.startSession({ taskId: task_id, model, baseBranch: base_branch })
        );
        if ("_error" in result) return errResult(`Error: ${result._error}`);
        return ok(
          `Started session #${result.id} on ${result.taskId} (model: ${result.model ?? "default"}).`
        );
      },
    });

    pi.registerTool({
      name: "task_orch__cancel_session",
      label: "Cancel Session",
      description: "Cancel a running agent session.",
      parameters: Type.Object({ session_id: Type.Integer() }),
      execute: async (_id, { session_id }) => {
        const result = safe(() => agentLib.cancelSession(session_id));
        if ("_error" in result) return errResult(`Error: ${result._error}`);
        return ok(`Session #${result.id} status: ${result.status}.`);
      },
    });
  };

// ──────────────────────────────────────────────────────
// Pure helpers (verbatim from lib/agent-mcp.ts)
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
