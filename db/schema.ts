import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

const NOW = sql`(unixepoch('subsec') * 1000)`;

export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  remote: text("remote"),
  localPath: text("local_path"),
  defaultBranch: text("default_branch").notNull().default("main"),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(NOW),
});

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    state: text("state").notNull().default("draft"),
    owner: text("owner"),
    body: text("body").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  },
  (t) => ({
    stateIdx: index("plans_state_idx").on(t.state),
  })
);

export const planRepositories = sqliteTable(
  "plan_repositories",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.planId, t.repoId] }),
    repoIdx: index("plan_repos_repo_idx").on(t.repoId),
  })
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    state: text("state").notNull().default("todo"),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    assignee: text("assignee"),
    body: text("body").notNull().default(""),
    estimate: text("estimate"),
    tags: text("tags").notNull().default("[]"),
    repoId: text("repo_id").references(() => repositories.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  },
  (t) => ({
    planIdx: index("tasks_plan_idx").on(t.planId),
    stateIdx: index("tasks_state_idx").on(t.state),
    assigneeIdx: index("tasks_assignee_idx").on(t.assignee),
    repoIdx: index("tasks_repo_idx").on(t.repoId),
  })
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.dependsOnId] }),
    dependsOnIdx: index("task_deps_depends_idx").on(t.dependsOnId),
  })
);

export const taskNotes = sqliteTable(
  "task_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    author: text("author").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  },
  (t) => ({
    taskIdx: index("task_notes_task_idx").on(t.taskId),
  })
);

export const acceptanceCriteria = sqliteTable(
  "acceptance_criteria",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull(),
  },
  (t) => ({
    taskIdx: index("ac_task_idx").on(t.taskId),
  })
);

export const agentSessions = sqliteTable(
  "agent_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Nullable since 0009: chat-derived runs have no task.
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    model: text("model"),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    prUrl: text("pr_url"),
    error: text("error"),
    totalCostUsd: real("total_cost_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    sdkSessionId: text("sdk_session_id"),
    resumeOf: integer("resume_of"),
    repoId: text("repo_id").references(() => repositories.id, { onDelete: "set null" }),
    goal: text("goal").notNull().default("<implement>"),
    toolsProfile: text("tools_profile").notNull().default("orchestrator,repo_write"),
    cwdStrategy: text("cwd_strategy").notNull().default("worktree"),
    parentRunId: integer("parent_run_id"),
    budgetMaxTurns: integer("budget_max_turns"),
    budgetMaxUsd: real("budget_max_usd"),
    budgetMaxSeconds: integer("budget_max_seconds"),
    outcome: text("outcome"),
    title: text("title"),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
    // Old chats.id for rows backfilled from chats by 0009. Lets the
    // future /chat/[id] redirect resolve the new run.
    legacyChatId: integer("legacy_chat_id"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(NOW),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    taskIdx: index("agent_runs_task_idx").on(t.taskId),
    statusIdx: index("agent_runs_status_idx").on(t.status),
    repoIdx: index("agent_runs_repo_idx").on(t.repoId),
    parentIdx: index("agent_runs_parent_idx").on(t.parentRunId),
    userIdx: index("agent_runs_user_idx").on(t.userId),
    legacyChatIdx: index("agent_runs_legacy_chat_idx").on(t.legacyChatId),
    personaIdx: index("agent_runs_persona_idx").on(t.personaId),
  })
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    // 'user' | 'agent' | 'tool' | 'system'.
    role: text("role").notNull(),
    // JSON array of SDK content blocks for user/agent/tool messages;
    // single-element array carrying {type,...payload} for system messages
    // backfilled from agent_events.
    content: text("content").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  },
  (t) => ({
    runIdx: index("agent_messages_run_idx").on(t.runId),
    runOrdIdx: index("agent_messages_run_id_ord_idx").on(t.runId, t.id),
  })
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: text("payload").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  },
  (t) => ({
    sessionIdx: index("agent_events_run_idx").on(t.sessionId),
    createdIdx: index("agent_events_created_idx").on(t.createdAt),
  })
);

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  },
  (t) => ({
    emailIdx: index("users_email_idx").on(t.email),
  })
);

export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt").notNull(),
  modelProvider: text("model_provider").notNull(),
  modelId: text("model_id").notNull(),
  thinkingLevel: text("thinking_level"),
  toolsProfile: text("tools_profile").notNull(),
  skillPaths: text("skill_paths").notNull().default("[]"),
  budgetMaxTurns: integer("budget_max_turns"),
  budgetMaxSeconds: integer("budget_max_seconds"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(NOW),
});

export const personaMemories = sqliteTable(
  "persona_memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    body: text("body").notNull().default(""),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(NOW),
  },
  (t) => ({
    personaIdx: index("persona_memories_persona_idx").on(t.personaId),
    uniq: index("persona_memories_persona_scope_uniq").on(t.personaId, t.scope),
  })
);

export type User = typeof users.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskNote = typeof taskNotes.$inferSelect;
export type AcceptanceCriterion = typeof acceptanceCriteria.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type Persona = typeof personas.$inferSelect;
export type PersonaMemory = typeof personaMemories.$inferSelect;
