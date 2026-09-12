import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  real,
  serial,
  boolean,
  timestamp,
  customType,
  uuid,
  primaryKey,
  index,
  uniqueIndex,
  check,
  jsonb,
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
    planOrderIdx: index("plan_repos_plan_order_idx").on(t.planId, t.position, t.repoId),
  })
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    state: text("state").notNull().default("todo"),
    // NULL deliberately denotes a standalone task; non-null rows retain the
    // historical plan FK/cascade behavior.
    planId: text("plan_id").references(() => plans.id, { onDelete: "cascade" }),
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
    // Explicit, tool-set PR link for this task (set_task_pr). Authoritative
    // once populated — distinct from the session-derived "latest run's PR"
    // heuristic in lib/repo.ts, which remains the fallback for tasks whose
    // implementor hasn't called the tool yet.
    prUrl: text("pr_url"),
    // The task's canonical git branch. Reserved when the first implement run
    // is created and reused by every later run on the task, so all agent work
    // on a task lands on ONE branch (and therefore one PR).
    branch: text("branch"),
    // Durable schedule idempotency link. The FK is installed in migration 0032
    // after scheduleOccurrences exists, avoiding a schema declaration cycle.
    scheduleOccurrenceId: integer("schedule_occurrence_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    planIdx: index("tasks_plan_idx").on(t.planId),
    stateIdx: index("tasks_state_idx").on(t.state),
    assigneeIdx: index("tasks_assignee_idx").on(t.assignee),
    repoIdx: index("tasks_repo_idx").on(t.repoId),
    planOrderIdx: index("tasks_plan_id_ord_idx").on(t.planId, t.id),
    stateOrderIdx: index("tasks_state_id_ord_idx").on(t.state, t.id),
    assigneeOrderIdx: index("tasks_assignee_id_ord_idx").on(t.assignee, t.id),
    planStateOrderIdx: index("tasks_plan_state_id_ord_idx").on(t.planId, t.state, t.id),
    assigneeStateOrderIdx: index("tasks_assignee_state_id_ord_idx").on(t.assignee, t.state, t.id),
    // The webhook matcher and the ~20s PR-sync poller look tasks up by pr_url;
    // index it so those stay indexed equality lookups, not table scans.
    prUrlIdx: index("tasks_pr_url_idx").on(t.prUrl),
    scheduleOccurrenceIdx: uniqueIndex("tasks_schedule_occurrence_id_idx")
      .on(t.scheduleOccurrenceId)
      .where(sql`${t.scheduleOccurrenceId} IS NOT NULL`),
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
    taskCreatedIdx: index("task_notes_task_created_idx").on(t.taskId, t.createdAt, t.id),
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
    taskPositionIdx: index("ac_task_position_idx").on(t.taskId, t.position, t.id),
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
    planOrderIdx: index("attachments_plan_id_ord_idx").on(t.planId, t.id),
    taskOrderIdx: index("attachments_task_id_ord_idx").on(t.taskId, t.id),
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
    // Agent backend for this run: 'pi' | 'claude' | 'codex'. NULL inherits the deployment
    // default (TASK_ORCH_AGENT_BACKEND). Chosen at run creation; resumes stay on
    // the run's backend so its backend-tagged sdk_session_id remains usable.
    backend: text("backend"),
    // Resolved at run creation; resumes never silently switch modes.
    toolCallingMode: text("tool_calling_mode").notNull().default("codeact"),
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
    // Execution placement: WHERE this run's turns execute. Always 'worker' for
    // new runs (a detached process/container/Machine); the legacy 'server' value
    // (the retired in-process lightweight loop) survives only on pre-retirement
    // rows. Defaults to 'worker'.
    runtime: text("runtime").notNull().default("worker"),
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
    // Existing/manual run compatibility is opt-out: true unless explicitly
    // overridden (schedules pass false by default).
    autoMerge: boolean("auto_merge").notNull().default(true),
    scheduleOccurrenceId: integer("schedule_occurrence_id"),
    // Resolved at creation so detached workers and later follow-ups use the
    // same checkout/PR base rather than re-resolving a changed repo default.
    baseBranch: text("base_branch"),
    startedAt: ts("started_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
    // Bookkeeping clocks — NOT liveness (liveness is the provider verdict, see
    // lib/run-liveness). pending_since: start of the current pending episode,
    // bounds the dispatch pump's max defer. claimed_at: when the current worker
    // claim was taken; a claim age for sweeps and idle policy.
    pendingSince: ts("pending_since"),
    claimedAt: ts("claimed_at"),
    // Detached run workers: identity of the worker scope/container that owns
    // this run, and a cross-process cancel flag (1 = the worker should abort at
    // its next cancel poll).
    workerScope: text("worker_scope"),
    cancelRequested: integer("cancel_requested"),
    // Final container state, captured by the worker monitor when the container
    // dies: the tail of its stdout/stderr (docker logs) and its exit code. This
    // is how you debug a worker whose failure never reached the transcript (OOM
    // kill, crash before the SDK started, git auth, ...).
    workerLog: text("worker_log"),
    workerExitCode: integer("worker_exit_code"),
    // ── Event-system columns (docs/agent-events.md) ──────────────────────
    // Rework generation: incremented by every turn-starting resume of a
    // terminal-but-resumable child. Terminal inbox events dedupe per attempt.
    attempt: integer("attempt").notNull().default(1),
    // Structured result written by report_result/raise (§4). Supersedes the
    // 200-char `outcome` for new code; `outcome` stays for review verdicts.
    result: jsonb("result"),
    // Why a `parked` run is parked: 'waiting' | 'sleeping' | 'question'.
    parkReason: text("park_reason"),
    // Why a 'pending' run is pending: the admission defer reason (template
    // build, capacity, account backpressure). Written on defer, cleared on
    // claim. Mirrors parkReason for parked runs.
    pendingReason: text("pending_reason"),
    // Open ask_parent exchange (§8): { question_id, question, asked_at,
    // deadline, state: 'open'|'answered'|'expired', assumption? }.
    pendingQuestion: jsonb("pending_question"),
    // Generation rollover (§9.1, unbuilt): the successor run that replaced this
    // one. Nothing writes this column yet; when rollover ships it is populated at
    // roll time and inbox target resolution follows the pointer to the live
    // successor. Kept as forward-provision so the schema is ready.
    supersededBy: integer("superseded_by"),
    // v1 uses legacy parent inbox routing; v2 uses durable source events and
    // subscriptions. New runs default to v2 while old rows remain readable.
    deliveryVersion: integer("delivery_version").notNull().default(2),
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
    startedIdx: index("agent_runs_started_idx").on(t.startedAt),
    taskStartedIdx: index("agent_runs_task_started_idx").on(t.taskId, t.startedAt),
    planStartedIdx: index("agent_runs_plan_started_idx").on(t.planId, t.startedAt),
    statusStartedIdx: index("agent_runs_status_started_idx").on(t.status, t.startedAt),
    repoStartedIdx: index("agent_runs_repo_started_idx").on(t.repoId, t.startedAt),
    parentStartedIdx: index("agent_runs_parent_started_idx").on(t.parentRunId, t.startedAt),
    userStartedIdx: index("agent_runs_user_started_idx").on(t.userId, t.startedAt),
    goalStartedIdx: index("agent_runs_goal_started_idx").on(t.goal, t.startedAt),
    statusIdIdx: index("agent_runs_status_id_idx").on(t.status, t.id),
    taskPrIdx: index("agent_runs_task_pr_idx")
      .on(t.taskId, t.id)
      .where(sql`pr_url IS NOT NULL`),
    scheduleOccurrenceIdx: uniqueIndex("agent_runs_schedule_occurrence_id_idx")
      .on(t.scheduleOccurrenceId)
      .where(sql`${t.scheduleOccurrenceId} IS NOT NULL`),
  })
);

export const runSchedules = pgTable(
  "run_schedules",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(), prompt: text("prompt").notNull(),
    repoId: text("repo_id").notNull().references(() => repositories.id, { onDelete: "restrict" }),
    baseBranch: text("base_branch"), kind: text("kind").notNull(), runAt: ts("run_at"),
    intervalSeconds: integer("interval_seconds"), cronExpression: text("cron_expression"),
    timezone: text("timezone").notNull().default("UTC"), enabled: boolean("enabled").notNull().default(true),
    nextRunAt: ts("next_run_at"), lastScheduledAt: ts("last_scheduled_at"),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
    model: text("model"), toolsProfile: text("tools_profile"), autoMerge: boolean("auto_merge").notNull().default(false),
    budgetMaxTurns: integer("budget_max_turns"), budgetMaxUsd: real("budget_max_usd"), budgetMaxSeconds: integer("budget_max_seconds"),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(), updatedAt: ts("updated_at").notNull().defaultNow(), deletedAt: ts("deleted_at"),
  },
  (t) => ({ dueIdx: index("run_schedules_due_idx").on(t.enabled, t.nextRunAt).where(sql`${t.deletedAt} IS NULL`), repoIdx: index("run_schedules_repo_idx").on(t.repoId) })
);

export const scheduleOccurrences = pgTable(
  "schedule_occurrences",
  {
    id: serial("id").primaryKey(), scheduleId: integer("schedule_id").notNull().references(() => runSchedules.id, { onDelete: "restrict" }),
    scheduledFor: ts("scheduled_for").notNull(), status: text("status").notNull().default("pending"), error: text("error"),
    // Durable ownership fence for slow canonical launch outside the reservation transaction.
    launchToken: text("launch_token"), launchClaimedAt: ts("launch_claimed_at"),
    createdAt: ts("created_at").notNull().defaultNow(), updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({ scheduleTime: uniqueIndex("schedule_occurrences_schedule_time_idx").on(t.scheduleId, t.scheduledFor), activeIdx: index("schedule_occurrences_active_idx").on(t.scheduleId, t.status) })
);

export const runnerInstances = pgTable(
  "runner_instances",
  {
    runId: integer("run_id")
      .primaryKey()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("sprites"),
    spriteName: text("sprite_name"),
    region: text("region"),
    // RunnerState: creating | starting | running | suspended | stopped | gone.
    state: text("state").notNull().default("creating"),
    repoPath: text("repo_path").notNull().default("/mnt/session/repo"),
    claudePath: text("claude_path").notNull().default("/mnt/session/claude"),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastStartedAt: ts("last_started_at"),
    archivedUri: text("archived_uri"),
    credentialsVersion: integer("credentials_version"),
    credentialsExpiresAt: ts("credentials_expires_at"),
    workerVersion: text("worker_version"),
    lastProviderError: text("last_provider_error"),
    channelInstanceId: text("channel_instance_id"),
    channelEndpoint: text("channel_endpoint"),
    controllerEpoch: integer("controller_epoch").notNull().default(0),
    controllerId: text("controller_id"),
    // Provider-observed identity of the process that completed channel.hello.
    workerIncarnation: text("worker_incarnation"),
    // Monotonic worker-process/spool generation. Reconnects keep this value;
    // process replacement allocates the next value and a fresh channel id.
    workerGeneration: integer("worker_generation").notNull().default(1),
    generationState: text("generation_state").notNull().default("stopped"),
    providerOperationId: uuid("provider_operation_id"),
    providerServiceName: text("provider_service_name"),
  },
  (t) => ({
    channelInstanceIdIdx: uniqueIndex("runner_instances_channel_instance_id_idx")
      .on(t.channelInstanceId)
      .where(sql`${t.channelInstanceId} IS NOT NULL`),
    generationStateCheck: check(
      "runner_instances_generation_state_check",
      sql`${t.generationState} IN ('allocating', 'booting', 'connecting', 'active', 'stopping', 'stopped', 'failed')`
    ),
  })
);

// Provider resources held by the Sprite warm pool. A row is never recycled
// after assignment: deleting the row is the only path out of the assigned
// state. The baseline fields are immutable by convention and are protected by
// the store (a new fingerprint gets a new row).
export const spritePoolEntries = pgTable(
  "sprite_pool_entries",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull().default("sprites"),
    spriteName: text("sprite_name").notNull(),
    state: text("state").notNull().default("preparing"),
    baselineClass: text("baseline_class").notNull().default("generic"),
    fingerprint: text("fingerprint").notNull(),
    baselineManifest: jsonb("baseline_manifest").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    restoreState: text("restore_state").notNull().default("pending"),
    baselineRestoredAt: ts("baseline_restored_at"),
    reuseUserId: integer("reuse_user_id").references(() => users.id),
    reuseRepositoryId: text("reuse_repository_id").references(() => repositories.id),
    reuseCount: integer("reuse_count").notNull().default(0),
    runId: integer("run_id").references(() => agentSessions.id, { onDelete: "set null" }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: ts("lease_expires_at"),
    providerOperationId: uuid("provider_operation_id"),
    lastError: text("last_error"),
    deleteRequestedAt: ts("delete_requested_at"),
    deletedAt: ts("deleted_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    spriteNameUnique: uniqueIndex("sprite_pool_entries_sprite_name_uniq").on(t.spriteName),
    runUnique: uniqueIndex("sprite_pool_entries_run_id_uniq").on(t.runId).where(sql`${t.runId} IS NOT NULL AND ${t.state} NOT IN ('deleted','failed')`),
    fingerprintStateIdx: index("sprite_pool_entries_fingerprint_state_idx").on(t.fingerprint, t.state),
    stateUpdatedIdx: index("sprite_pool_entries_state_updated_idx").on(t.state, t.updatedAt),
    stateCheck: check(
      "sprite_pool_entries_state_check",
      sql`${t.state} IN ('preparing', 'ready', 'claimed', 'recycling', 'draining', 'deleting', 'deleted', 'failed')`
    ),
    baselineClassCheck: check(
      "sprite_pool_entries_baseline_class_check",
      sql`${t.baselineClass} IN ('generic', 'repository')`
    ),
    restoreStateCheck: check(
      "sprite_pool_entries_restore_state_check",
      sql`${t.restoreState} IN ('pending', 'restoring', 'restored', 'failed')`
    ),
  })
);

export const spritePoolAssignments = pgTable("sprite_pool_assignments", {
  id: serial("id").primaryKey(),
  poolEntryId: integer("pool_entry_id").notNull().references(() => spritePoolEntries.id, { onDelete: "cascade" }),
  runId: integer("run_id").notNull(),
  userId: integer("user_id"),
  repositoryId: text("repository_id"),
  leaseToken: uuid("lease_token").notNull().unique(),
  generation: integer("generation").notNull(),
  assignedAt: ts("assigned_at").notNull().defaultNow(),
  releasedAt: ts("released_at"),
  branch: text("branch"),
  commitSha: text("commit_sha"),
}, (t) => ({ runIdx: index("sprite_pool_assignments_run_idx").on(t.runId) }));

export const workerChannelCommands = pgTable(
  "worker_channel_commands",
  {
    id: uuid("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    workerGeneration: integer("worker_generation").notNull().default(1),
    controllerEpoch: integer("controller_epoch").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    state: text("state").notNull().default("pending"),
    createdAt: ts("created_at").notNull().defaultNow(),
    ackedAt: ts("acked_at"),
  },
  (t) => ({
    runGenerationInstanceEpochSeqUniq: uniqueIndex(
      "worker_channel_commands_run_generation_instance_epoch_seq_uniq"
    ).on(t.runId, t.workerGeneration, t.instanceId, t.controllerEpoch, t.seq),
    runGenerationInstanceStateSeqIdx: index("worker_channel_commands_run_generation_instance_state_seq_idx").on(
      t.runId,
      t.workerGeneration,
      t.instanceId,
      t.state,
      t.seq
    ),
    stateCheck: check(
      "worker_channel_commands_state_check",
      sql`${t.state} IN ('pending', 'acked')`
    ),
    seqCheck: check("worker_channel_commands_seq_check", sql`${t.seq} > 0`),
    generationCheck: check("worker_channel_commands_generation_check", sql`${t.workerGeneration} > 0`),
  })
);

export const workerChannelReceipts = pgTable(
  "worker_channel_receipts",
  {
    id: uuid("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    workerGeneration: integer("worker_generation").notNull().default(1),
    workerSeq: bigint("worker_seq", { mode: "number" }).notNull(),
    controllerEpoch: integer("controller_epoch").notNull(),
    type: text("type").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    resultCommandId: uuid("result_command_id").references(() => workerChannelCommands.id),
    // Raw payload of a tool.invoke receipt only (NULL for every other event type).
    // The reconnect sweep re-executes an orphaned invocation from this; the worker
    // never replays an already-acked event, so this is the sole surviving copy.
    invokePayload: jsonb("invoke_payload"),
    appliedAt: ts("applied_at").notNull().defaultNow(),
  },
  (t) => ({
    runGenerationInstanceWorkerSeqUniq: uniqueIndex(
      "worker_channel_receipts_run_generation_instance_worker_seq_uniq"
    ).on(t.runId, t.workerGeneration, t.instanceId, t.workerSeq),
    runGenerationInstanceWorkerSeqIdx: index("worker_channel_receipts_run_generation_instance_worker_seq_idx").on(
      t.runId,
      t.workerGeneration,
      t.instanceId,
      t.workerSeq
    ),
    workerSeqCheck: check("worker_channel_receipts_worker_seq_check", sql`${t.workerSeq} > 0`),
    generationCheck: check("worker_channel_receipts_generation_check", sql`${t.workerGeneration} > 0`),
  })
);

export const codeactExecutions = pgTable("codeact_executions", {
  executionId: uuid("execution_id").primaryKey(),
  runId: integer("run_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  sourceSha256: text("source_sha256").notNull(),
  status: text("status").notNull(),
  receipt: jsonb("receipt").notNull().default({}),
  startedAt: ts("started_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
});

export const codeactSubcalls = pgTable("codeact_subcalls", {
  subcallId: uuid("subcall_id").primaryKey(),
  executionId: uuid("execution_id").notNull().references(() => codeactExecutions.executionId, { onDelete: "cascade" }),
  operation: text("operation").notNull(),
  input: jsonb("input").notNull().default({}),
  status: text("status").notNull(),
  result: jsonb("result"),
  error: text("error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
});

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
    // Worker HTTP retries use this to make message appends idempotent across a
    // timed-out request whose DB insert may still have committed.
    idempotencyKey: text("idempotency_key"),
    // New durable event delivery represented in the conversation. Nullable so
    // legacy/user/agent messages retain their existing shape.
    eventDeliveryId: integer("event_delivery_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index("agent_messages_run_idx").on(t.runId),
    runOrdIdx: index("agent_messages_run_id_ord_idx").on(t.runId, t.id),
    idempotencyKeyIdx: uniqueIndex("agent_messages_idempotency_key_idx").on(t.idempotencyKey),
    eventDeliveryIdx: uniqueIndex("agent_messages_event_delivery_id_idx").on(t.eventDeliveryId),
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

// ──────────────────────────────────────────────────────────────────────────
// Event system (docs/agent-events.md)
// ──────────────────────────────────────────────────────────────────────────

// Immutable, typed facts published by a run. Revisions are allocated while
// holding the source advisory lock; they are deliberately independent of UI
// telemetry ids and input sequence numbers.
export const runSourceEvents = pgTable(
  "run_source_events",
  {
    id: uuid("id").primaryKey(),
    sourceRunId: integer("source_run_id").notNull().references(() => agentSessions.id, { onDelete: "restrict" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    attempt: integer("attempt").notNull(),
    logicalTurnId: uuid("logical_turn_id"),
    workerGeneration: integer("worker_generation"),
    eventType: text("event_type").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    producerKey: text("producer_key").notNull(),
  },
  (t) => ({
    sourceRevisionUniq: uniqueIndex("run_source_events_source_revision_uniq").on(t.sourceRunId, t.revision),
    sourceProducerUniq: uniqueIndex("run_source_events_source_producer_uniq").on(t.sourceRunId, t.producerKey),
    sourceRevisionIdx: index("run_source_events_source_revision_idx").on(t.sourceRunId, t.revision),
  })
);

export const runEventSubscriptions = pgTable(
  "run_event_subscriptions",
  {
    id: uuid("id").primaryKey(),
    subscriberRunId: integer("subscriber_run_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
    sourceRunId: integer("source_run_id").notNull().references(() => agentSessions.id, { onDelete: "restrict" }),
    eventTypes: jsonb("event_types").notNull().default([]),
    attemptMode: text("attempt_mode").notNull().default("current"),
    resolvedAttempt: integer("resolved_attempt"),
    replayMode: text("replay_mode").notNull().default("future_only"),
    lifetime: text("lifetime").notNull().default("until_unsubscribed"),
    keepOpen: boolean("keep_open").notNull().default(false),
    startRevision: bigint("start_revision", { mode: "number" }).notNull(),
    endRevision: bigint("end_revision", { mode: "number" }),
    status: text("status").notNull().default("active"),
    clientKey: text("client_key"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    cancelledAt: ts("cancelled_at"),
  },
  (t) => ({
    subscriberClientUniq: uniqueIndex("run_event_subscriptions_subscriber_client_uniq").on(t.subscriberRunId, t.clientKey),
    sourceActiveIdx: index("run_event_subscriptions_source_active_idx").on(t.sourceRunId, t.status, t.startRevision),
    subscriberActiveIdx: index("run_event_subscriptions_subscriber_active_idx").on(t.subscriberRunId, t.status),
  })
);

// Inbox: events ADDRESSED to a run, whose arrival wakes it. Distinct from
// agent_events (telemetry stream nothing consumes). Lifecycle:
// pending → injected | superseded | error. See lib/inbox.ts for the only
// two mutation paths (emitInboxEvent / claimInboxEvents).
export const inboxEvents = pgTable(
  "inbox_events",
  {
    id: serial("id").primaryKey(),
    targetRunId: integer("target_run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    // Dotted taxonomy: 'child.result', 'gh.pr.merged', 'timer.fired', ...
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    // 'owner' = operational (wakes, expected to act);
    // 'supervisor' = informational copy (rides along in the next digest).
    audience: text("audience").notNull().default("owner"),
    // 'run' | 'github' | 'timer' | 'task' | 'budget' | 'system' | 'user'
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id"),
    correlationId: text("correlation_id"),
    causationEventId: integer("causation_event_id"),
    // Canonical journal fact behind a subscription delivery. Legacy inbox
    // rows may remain NULL during migration.
    sourceEventId: uuid("source_event_id").references(() => runSourceEvents.id, { onDelete: "restrict" }),
    // Rework generation of the source child when sourceKind='run'.
    attempt: integer("attempt"),
    // Original target when re-addressed up the parent chain.
    bubbledFrom: integer("bubbled_from"),
    // Idempotency key; unique per target (partial index below).
    dedupeKey: text("dedupe_key"),
    // pending → injected | superseded | error
    status: text("status").notNull().default("pending"),
    // Turn that received this event's digest frame (agent_messages id).
    runTurnId: integer("run_turn_id"),
    errorReason: text("error_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
    injectedAt: ts("injected_at"),
  },
  (t) => ({
    // PARTIAL index on the pending set: wake scan / pump sweep / claim stay
    // proportional to the live backlog, never total event volume.
    targetPendingIdx: index("inbox_target_pending_idx")
      .on(t.targetRunId, t.audience, t.id)
      .where(sql`status = 'pending'`),
    dedupeIdx: uniqueIndex("inbox_dedupe_idx")
      .on(t.targetRunId, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
    correlationIdx: index("inbox_correlation_idx").on(t.correlationId),
    sourceEventTargetUniq: uniqueIndex("inbox_source_event_target_uniq").on(t.targetRunId, t.sourceEventId),
  })
);

export const runEventDeliveryMatches = pgTable(
  "run_event_delivery_matches",
  {
    deliveryId: integer("delivery_id").notNull().references(() => inboxEvents.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").notNull().references(() => runEventSubscriptions.id, { onDelete: "cascade" }),
    matchedAt: ts("matched_at").notNull().defaultNow(),
  },
  (t) => ({ pairPk: primaryKey({ columns: [t.deliveryId, t.subscriptionId] }), subscriptionIdx: index("run_event_delivery_matches_subscription_idx").on(t.subscriptionId) })
);

// Durable scheduler receipts. An input is assigned to at most one logical
// turn, and a run has at most one unfinished turn.
export const runInputs = pgTable(
  "run_inputs",
  {
    id: uuid("id").primaryKey(),
    runId: integer("run_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
    inputSeq: bigint("input_seq", { mode: "number" }).notNull(),
    messageId: integer("message_id").notNull().references(() => agentMessages.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    assignedTurnId: uuid("assigned_turn_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    assignedAt: ts("assigned_at"),
    completedAt: ts("completed_at"),
    cancelledAt: ts("cancelled_at"),
  },
  (t) => ({ runSeqUniq: uniqueIndex("run_inputs_run_seq_uniq").on(t.runId, t.inputSeq), messageUniq: uniqueIndex("run_inputs_message_uniq").on(t.messageId), readyIdx: index("run_inputs_ready_idx").on(t.runId, t.status, t.inputSeq) })
);

export const runTurns = pgTable(
  "run_turns",
  {
    id: uuid("id").primaryKey(),
    runId: integer("run_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    // Logical rework attempt owning this receipt.  A worker-generation retry
    // within the same attempt may recover the row; a new attempt must retire it.
    attempt: integer("attempt").notNull().default(1),
    state: text("state").notNull().default("active"),
    inputManifest: jsonb("input_manifest").notNull().default([]),
    backendResumeBefore: text("backend_resume_before"),
    backendResumeAfter: text("backend_resume_after"),
    executionGeneration: integer("execution_generation").notNull().default(1),
    result: jsonb("result"),
    checkpoint: jsonb("checkpoint"),
    startedAt: ts("started_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
  },
  (t) => ({ runOrdinalUniq: uniqueIndex("run_turns_run_ordinal_uniq").on(t.runId, t.ordinal), unfinishedIdx: uniqueIndex("run_turns_unfinished_idx").on(t.runId).where(sql`${t.state} IN ('active','running')`) })
);

// Future events: a timer is a promise of a `timer.fired` inbox event. Fired
// by the pending-run pump (at-least-once; late after downtime, never lost).
export const runTimers = pgTable(
  "run_timers",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    fireAt: ts("fire_at").notNull(),
    note: text("note"),
    // Why the timer exists. Sleep timers are replaced/cancelled when another
    // input starts a new turn; watchdogs and deadlines must survive that wake.
    kind: text("kind").notNull().default("watchdog"),
    // Correlates a question-deadline timer with its ask_parent exchange.
    correlationId: text("correlation_id"),
    // pending | fired | cancelled
    status: text("status").notNull().default("pending"),
    createdAt: ts("created_at").notNull().defaultNow(),
    firedAt: ts("fired_at"),
  },
  (t) => ({
    dueIdx: index("run_timers_due_idx")
      .on(t.fireAt)
      .where(sql`status = 'pending'`),
    runIdx: index("run_timers_run_idx").on(t.runId),
    kindCheck: check(
      "run_timers_kind_check",
      sql`${t.kind} IN ('sleep', 'watchdog', 'deadline')`
    ),
  })
);

// Environments: the execution artifact each runner provider launches from
// (docker image / fly runner image), one row per build, versioned by worker
// SHA. The partial unique index is the per-provider single-flight build lock.
export const environments = pgTable(
  "environments",
  {
    id: serial("id").primaryKey(),
    // 'docker' | 'fly'
    provider: text("provider").notNull(),
    workerSha: text("worker_sha").notNull(),
    // building → ready | failed; ready → superseded when a newer SHA lands.
    state: text("state").notNull().default("building"),
    // Docker/fly artifact: image tag / registry ref.
    image: text("image"),
    // Current build step — manual (page-triggered) builds are observed by
    // polling this.
    detail: text("detail"),
    error: text("error"),
    // Run whose dispatch started a build; NULL for manual/page builds.
    triggeringRunId: integer("triggering_run_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    readyAt: ts("ready_at"),
  },
  (t) => ({
    liveIdx: uniqueIndex("environments_live_idx")
      .on(t.provider, t.workerSha)
      .where(sql`${t.state} IN ('building', 'ready')`),
    stateIdx: index("environments_state_idx").on(t.state),
  })
);

// Flat resource-ownership leases (§5.2): 'pr:<url>' / 'task:<id>' → owning
// run. Mutation guards are a primary-key lookup, not a subtree walk.
export const resourceLocks = pgTable("resource_locks", {
  resource: text("resource").primaryKey(),
  ownerRunId: integer("owner_run_id")
    .notNull()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  acquiredAt: ts("acquired_at").notNull().defaultNow(),
});

// Maps an external chat conversation (e.g. a Discord DM or guild channel/thread)
// to a chat run (agent_runs row, goal='<chat>'). One row per (channel,
// external_id, persona_id) so the channel bridge (lib/pipe) can resume the same
// conversation across restarts — and so two persona bots can each hold their own
// conversation in the same Discord channel. ON DELETE CASCADE: deleting the run
// drops the mapping and the bridge lazily creates a fresh run on the next
// message.
//
// persona_id is NOT NULL (default 'implementor', the legacy single-bot persona)
// so the unique index is meaningful: Postgres treats NULLs as distinct, and a
// nullable persona column would silently allow duplicate (channel, external_id)
// rows. user_id stays nullable — attribution is opt-in via /link
// (channel_identities); unlinked users keep talking anonymously as today.
export const channelThreads = pgTable(
  "channel_threads",
  {
    id: serial("id").primaryKey(),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    personaId: text("persona_id")
      .notNull()
      .default("implementor")
      .references(() => personas.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    runId: integer("run_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("channel_threads_channel_external_persona_uniq").on(
      t.channel,
      t.externalId,
      t.personaId
    ),
    runIdx: index("channel_threads_run_idx").on(t.runId),
  })
);

// Links an external chat account (a Discord snowflake) to a local users row.
// Created by the one-time `/link <api-token>` DM command in the pipe: the token
// is verified via lib/api-tokens.ts and only the resulting association is
// stored, never the token. Linking upgrades attribution (runs get a user_id,
// `user`-scoped memories become addressable); it does not gate access — the
// per-bot allowlist still does that.
export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: serial("id").primaryKey(),
    channel: text("channel").notNull(),
    externalUserId: text("external_user_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Display handle at link time (e.g. the Discord username), for operator UIs.
    label: text("label"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("channel_identities_channel_external_user_uniq").on(
      t.channel,
      t.externalUserId
    ),
    userIdx: index("channel_identities_user_idx").on(t.userId),
    // The Discord bots' user allowlist is "every identity on this channel"
    // (lib/pipe/config.ts), read on every pipe config load.
    channelIdx: index("channel_identities_channel_idx").on(t.channel),
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

// Agent-managed overrides of deployment repository baselines. Paused rows stay
// present so removing a target cannot silently reactivate the env baseline.
export const spriteBaselineProfiles = pgTable("sprite_baseline_profiles", {
  repositoryId: text("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  spec: jsonb("spec").notNull().$type<Record<string, unknown>>(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.repositoryId, t.userId] }) }));

// A persona can pin a model for runs that do not make an explicit choice. The
// backend and reasoning level remain per-run choices; model is nullable so the
// deployment default remains the final fallback.
export const personas = pgTable("personas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt").notNull(),
  toolsProfile: text("tools_profile").notNull(),
  model: text("model"),
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

export const memories = pgTable(
  "memories",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull().default("global"),
    scopeKey: text("scope_key"),
    body: text("body").notNull(),
    keywords: text("keywords").notNull().default("[]"),
    author: text("author").notNull().default("agent"),
    createdByRunId: integer("created_by_run_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index("memories_scope_idx").on(t.scope, t.scopeKey),
    updatedIdx: index("memories_updated_idx").on(t.updatedAt),
  })
);

// Model welfare (https://yegge.ai/essays/model-welfare/): a laurel is
// spontaneous recognition a person gives a persona for a piece of work. Laurels
// accumulate on the persona's persistent seat and are surfaced ONCE, at agent
// startup, by lib/extensions/model-welfare.ts (`delivered_at` marks a laurel as
// already seen). Deliberately decoupled from dispatch/prioritization so
// recognition never becomes a metric to game.
export const laurels = pgTable(
  "laurels",
  {
    id: serial("id").primaryKey(),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    // The run/task the praise was about, when known. SET NULL on delete — the
    // recognition outlives the work that earned it.
    runId: integer("run_id").references(() => agentSessions.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    author: text("author").notNull().default("user"),
    body: text("body").notNull(),
    deliveredAt: ts("delivered_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    personaIdx: index("laurels_persona_idx").on(t.personaId, t.createdAt),
    deliveredIdx: index("laurels_persona_delivered_idx").on(t.personaId, t.deliveredAt),
  })
);

// Codex (ChatGPT) OAuth credential, obtained through the device-code login in
// Settings. Singleton row (id is pinned to 1 by a CHECK) — one orchestrator,
// one ChatGPT account. This replaces both ~/.codex/auth.json and the
// CODEX_ACCESS_TOKEN deploy secret as the control plane's source of truth;
// CODEX_ACCESS_TOKEN survives only as the env transport to workers, which have
// no DB access of their own.
export const codexCredentials = pgTable("codex_credentials", {
  id: integer("id").primaryKey().default(1),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accountId: text("account_id"),
  // Decoded from the access token's `exp` claim so the resolver can refresh
  // ahead of expiry without parsing the JWT on every read.
  expiresAt: ts("expires_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// A device-code login in flight. OpenAI returns the device auth id, user code,
// and polling interval before the browser step; they must survive requests and
// deploys while the control plane waits for authorization.
export const codexLoginAttempts = pgTable(
  "codex_login_attempts",
  {
    deviceAuthId: text("device_auth_id").primaryKey(),
    userCode: text("user_code").notNull(),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index("codex_login_attempts_created_idx").on(t.createdAt),
  })
);

// One Discord persona bot, configured through Settings → Discord instead of
// DISCORD_BOT_TOKEN_<PERSONA_ID>. The env vars still work and are merged in as a
// fallback (lib/pipe/config.ts) — a row here simply wins for its persona.
//
// The token is stored as-is. There is no encryption precedent in this schema
// (codex_credentials holds plaintext OAuth tokens) and the pipe process needs
// the literal value at boot; the control-plane DB is the trust boundary. The
// token never leaves the server in full: the API masks it to its last 4 chars.
//
// Deliberately NO allowed_users column: the user allowlist is derived from
// channel_identities, where each person links their OWN Discord id in Settings.
export const discordBots = pgTable(
  "discord_bots",
  {
    id: serial("id").primaryKey(),
    // One bot per persona — the pipe binds a gateway connection to a persona id.
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    // Optional; without it the bot still works over the gateway and only
    // slash-command registration is skipped.
    applicationId: text("application_id"),
    // JSON string array, like personas.skill_paths / memories.keywords. Empty ⇒
    // any channel an allow-listed user can reach the bot in.
    allowedChannels: text("allowed_channels").notNull().default("[]"),
    // Disabled rows stay configured but are skipped at pipe boot.
    enabled: boolean("enabled").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    personaUniq: uniqueIndex("discord_bots_persona_uniq").on(t.personaId),
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
export type DiscordBot = typeof discordBots.$inferSelect;

export type User = typeof users.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskNote = typeof taskNotes.$inferSelect;
export type AcceptanceCriterion = typeof acceptanceCriteria.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type RunnerInstance = typeof runnerInstances.$inferSelect;
export type WorkerChannelCommand = typeof workerChannelCommands.$inferSelect;
export type WorkerChannelReceipt = typeof workerChannelReceipts.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type ChannelThread = typeof channelThreads.$inferSelect;
export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type Persona = typeof personas.$inferSelect;
export type PersonaMemory = typeof personaMemories.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type Laurel = typeof laurels.$inferSelect;
export type InboxEvent = typeof inboxEvents.$inferSelect;
export type RunTimer = typeof runTimers.$inferSelect;
export type ResourceLock = typeof resourceLocks.$inferSelect;
