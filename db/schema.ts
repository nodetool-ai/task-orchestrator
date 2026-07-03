import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  real,
  serial,
  boolean,
  timestamp,
  customType,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

// Millisecond-epoch timestamps became Postgres `timestamptz` (Date semantics
// preserved: mode:"date" round-trips JS Date). Ordering/cursors key on the
// serial `id`, not timestamps, so microsecond precision is irrelevant.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// Raw bytes for attachment content. postgres.js returns bytea as a Uint8Array;
// normalize to Buffer so callers keep the previous better-sqlite3 blob shape.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  },
});

export const repositories = pgTable("repositories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  remote: text("remote"),
  localPath: text("local_path"),
  defaultBranch: text("default_branch").notNull().default("main"),
  description: text("description").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const plans = pgTable(
  "plans",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    state: text("state").notNull().default("draft"),
    owner: text("owner"),
    body: text("body").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    stateIdx: index("plans_state_idx").on(t.state),
  })
);

export const planRepositories = pgTable(
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

export const tasks = pgTable(
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
    // The task's single canonical "attached run" — the worktree session that
    // carries implement / chat / merge turns. NULL until first interaction. FK to
    // agent_runs.id ON DELETE SET NULL is applied in a migration; omitted here to
    // avoid a tasks↔agent_runs type-inference cycle.
    attachedRunId: integer("attached_run_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    planIdx: index("tasks_plan_idx").on(t.planId),
    stateIdx: index("tasks_state_idx").on(t.state),
    assigneeIdx: index("tasks_assignee_idx").on(t.assignee),
    repoIdx: index("tasks_repo_idx").on(t.repoId),
  })
);

export const taskDependencies = pgTable(
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

export const taskNotes = pgTable(
  "task_notes",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    author: text("author").notNull(),
    body: text("body").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index("task_notes_task_idx").on(t.taskId),
  })
);

export const acceptanceCriteria = pgTable(
  "acceptance_criteria",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    position: integer("position").notNull(),
  },
  (t) => ({
    taskIdx: index("ac_task_idx").on(t.taskId),
  })
);

export const attachments = pgTable(
  "attachments",
  {
    id: serial("id").primaryKey(),
    // Exactly one of planId / taskId is set (XOR enforced by a CHECK constraint).
    // Both FKs cascade on owner delete.
    planId: text("plan_id").references(() => plans.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    // 'image' for image/* mime types, 'artifact' otherwise. Derived at insert.
    kind: text("kind").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    content: bytea("content").notNull(),
    author: text("author").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    planIdx: index("attachments_plan_idx").on(t.planId),
    taskIdx: index("attachments_task_idx").on(t.taskId),
    // Exactly one owner: plan XOR task.
    ownerXor: check(
      "attachments_owner_xor",
      sql`(${t.planId} IS NOT NULL) <> (${t.taskId} IS NOT NULL)`
    ),
  })
);

export const agentSessions = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    // Nullable: chat-derived runs have no task.
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    // Nullable: chat-derived runs that target a plan as a whole carry the
    // plan_id here so the agent can scope task CRUD to it.
    planId: text("plan_id").references(() => plans.id, { onDelete: "set null" }),
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
    // Reasoning level: low | medium | high | xhigh. NULL inherits the persona's
    // level (which may itself be NULL = model default).
    thinkingLevel: text("thinking_level"),
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
    // Old chats.id for rows backfilled from chats. Lets the /chat/[id] redirect
    // resolve the new run.
    legacyChatId: integer("legacy_chat_id"),
    // Null for ordinary runs. Non-null for planning-agent runs:
    // gathering | spec_review | building_plan | plan_review | committing | done
    planningStage: text("planning_stage"),
    startedAt: ts("started_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
    // Liveness lease: bumped periodically while a turn runs. A run in an active
    // status with a stale/null heartbeat is an orphan (its owner process died).
    heartbeatAt: ts("heartbeat_at"),
    // Detached run workers: identity of the transient worker scope/container that
    // owns this run, the worker pid, and a cross-process cancel flag (1 = a
    // redeploy-surviving worker should abort at the next heartbeat poll).
    workerScope: text("worker_scope"),
    workerPid: integer("worker_pid"),
    cancelRequested: integer("cancel_requested"),
  },
  (t) => ({
    taskIdx: index("agent_runs_task_idx").on(t.taskId),
    planIdx: index("agent_runs_plan_idx").on(t.planId),
    statusIdx: index("agent_runs_status_idx").on(t.status),
    repoIdx: index("agent_runs_repo_idx").on(t.repoId),
    parentIdx: index("agent_runs_parent_idx").on(t.parentRunId),
    userIdx: index("agent_runs_user_idx").on(t.userId),
    legacyChatIdx: index("agent_runs_legacy_chat_idx").on(t.legacyChatId),
    personaIdx: index("agent_runs_persona_idx").on(t.personaId),
  })
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    // 'user' | 'agent' | 'tool' | 'system'.
    role: text("role").notNull(),
    // JSON array of SDK content blocks for user/agent/tool messages; single-
    // element array carrying {type,...payload} for system messages.
    content: text("content").notNull().default("[]"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index("agent_messages_run_idx").on(t.runId),
    runOrdIdx: index("agent_messages_run_id_ord_idx").on(t.runId, t.id),
  })
);

export const agentEvents = pgTable(
  "agent_events",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: text("payload").notNull().default("{}"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index("agent_events_run_idx").on(t.sessionId),
    createdIdx: index("agent_events_created_idx").on(t.createdAt),
    // (run_id, id) makes the DB-tail cursor scan (readStreamSince) a covered
    // lookup; agent_messages' equivalent is agent_messages_run_id_ord_idx above.
    runOrdIdx: index("idx_agent_events_run_id").on(t.sessionId, t.id),
  })
);

// Maps an external chat conversation (e.g. a Discord DM or guild channel/thread)
// to a chat run (agent_runs row, goal='<chat>'). One row per (channel,
// external_id) so the channel bridge (lib/pipe) can resume the same conversation
// across restarts. ON DELETE CASCADE: deleting the run drops the mapping and the
// bridge lazily creates a fresh run on the next message.
export const channelThreads = pgTable(
  "channel_threads",
  {
    id: serial("id").primaryKey(),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    runId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("channel_threads_channel_external_uniq").on(t.channel, t.externalId),
    runIdx: index("channel_threads_run_idx").on(t.runId),
  })
);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index("users_email_idx").on(t.email),
  })
);

export const personas = pgTable("personas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt").notNull(),
  thinkingLevel: text("thinking_level"),
  toolsProfile: text("tools_profile").notNull(),
  skillPaths: text("skill_paths").notNull().default("[]"),
  budgetMaxTurns: integer("budget_max_turns"),
  budgetMaxSeconds: integer("budget_max_seconds"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const personaMemories = pgTable(
  "persona_memories",
  {
    id: serial("id").primaryKey(),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    body: text("body").notNull().default(""),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    personaIdx: index("persona_memories_persona_idx").on(t.personaId),
    uniq: uniqueIndex("persona_memories_persona_scope_uniq").on(t.personaId, t.scope),
  })
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => ({
    userIdx: index("api_tokens_user_idx").on(t.userId),
    prefixIdx: index("api_tokens_prefix_idx").on(t.prefix),
  })
);

export type ApiToken = typeof apiTokens.$inferSelect;

export type User = typeof users.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskNote = typeof taskNotes.$inferSelect;
export type AcceptanceCriterion = typeof acceptanceCriteria.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type ChannelThread = typeof channelThreads.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type Persona = typeof personas.$inferSelect;
export type PersonaMemory = typeof personaMemories.$inferSelect;
