// lib/codeact/operation-manifest.ts
//
// Checked-in product-operation coverage manifest for the CodeAct migration
// (plan P-2026-09-07-codeact-migration, task T-20260908-0001).
//
// Goal of the migration: "every supported product operation has a sandbox API,
// including functionality currently available only through REST, CLI, or UI
// actions." This manifest is the inventory that makes "every" auditable. It
// enumerates each operation the product exposes today across four surfaces
// (REST routes, CLI commands, agent tools, UI/server actions), and classifies
// each one as:
//
//   - "sdk"      → must be reachable from the CodeAct `app` SDK. `sdkNamespace`
//                  names the proposed method. This is the coverage obligation
//                  later milestones (esp. T-20260908-0005) are measured against.
//   - "alias"    → a second *name* for an operation already counted under "sdk"
//                  (prefix-aliased tool names, cross-surface duplicates like
//                  "POST /api/tasks" ≡ tool create_task ≡ CLI `new task`).
//                  `aliasOf` points at the canonical entry id. Compatibility
//                  aliases (`tools.*`, `task_orch__*`) are retained during
//                  migration per the plan.
//   - "excluded" → deliberately NOT given a guest SDK method. `exclusionReason`
//                  justifies it (transport/protocol plumbing, auth callbacks,
//                  health/metrics, streaming operational endpoints, internal
//                  worker lifecycle, ambient persona mechanisms).
//
// The companion narrative (methodology, per-surface counts, classification
// rules) lives in docs/codeact/operation-coverage.md. Invariants are enforced
// by __tests__/codeact-operation-manifest.test.ts.
//
// This is a milestone-1 inventory, not the final SDK shape: `sdkNamespace`
// values are proposed targets, and the manifest is expected to evolve as the
// registry/dispatcher (T-20260908-0003) and full coverage (T-20260908-0005)
// land. It is intentionally exhaustive over TODAY's surfaces so nothing is
// silently dropped in the move to CodeAct.

export type OperationSurface = "rest" | "cli" | "tool" | "ui_action";

export type CoverageClass = "sdk" | "alias" | "excluded";

export type OperationDomain =
  | "sprites"
  | "snapshots"
  | "repositories"
  | "plans"
  | "tasks"
  | "notes"
  | "criteria"
  | "attachments"
  | "sessions"
  | "runs"
  | "chats"
  | "schedules"
  | "personas"
  | "config"
  | "users"
  | "auth"
  | "integration"
  | "events"
  | "planning"
  | "spawn"
  | "memory"
  | "welfare"
  | "github"
  | "repo_fs"
  | "search"
  | "system";

export interface OperationEntry {
  /** Stable manifest id, unique across all surfaces. */
  id: string;
  surface: OperationSurface;
  domain: OperationDomain;
  /** Human-facing operation name (path, command, or tool name). */
  name: string;
  /** One-line description of the effect. */
  description: string;
  coverage: CoverageClass;
  /** Proposed CodeAct SDK method (coverage === "sdk"). */
  sdkNamespace?: string;
  /** Canonical entry id this is an alias of (coverage === "alias"). */
  aliasOf?: string;
  /** Justification (coverage === "excluded"). */
  exclusionReason?: string;
}

// ---------------------------------------------------------------------------
// 1. Agent tools — the core migration surface. Source registries:
//    lib/orchestrator-tools.ts, lib/extensions/*, lib/worker/server-tools.ts.
//    (Bare names; prefix aliases captured separately in section 5.)
// ---------------------------------------------------------------------------

const TOOL_OPS: OperationEntry[] = [
  t("snapshots", "snapshots_list", "Sprite list", "app.snapshots.list"),
  t("snapshots", "snapshots_prepare", "Sprite prepare", "app.snapshots.prepare"),
  t("snapshots", "snapshots_setTarget", "Sprite setTarget", "app.snapshots.setTarget"),
  t("snapshots", "snapshots_retire", "Sprite retire", "app.snapshots.retire"),
  t("snapshots", "snapshots_listCheckpoints", "Sprite listCheckpoints", "app.snapshots.listCheckpoints"),
  t("snapshots", "snapshots_checkpoint", "Sprite checkpoint", "app.snapshots.checkpoint"),
  t("sprites", "sprites_list", "Sprite list", "app.sprites.list"),
  t("sprites", "sprites_exec", "Sprite exec", "app.sprites.exec"),
  t("sprites", "sprites_startCommand", "Sprite startCommand", "app.sprites.startCommand"),
  t("sprites", "sprites_commandStatus", "Sprite commandStatus", "app.sprites.commandStatus"),
  // Repositories (ORCHESTRATOR_TOOLS)
  t("repositories", "list_repositories", "List configured repositories", "app.repositories.list"),
  t("repositories", "get_repository", "Get a repository's details", "app.repositories.get"),
  t("repositories", "create_repository", "Register a new repository", "app.repositories.create"),
  t("repositories", "update_repository", "Patch repository fields", "app.repositories.update"),
  t("repositories", "delete_repository", "Delete a repository", "app.repositories.delete"),
  // Scheduled jobs (shared direct/MCP/CodeAct tools)
  t("schedules", "schedules_list", "List scheduled jobs", "app.schedules.list"),
  t("schedules", "schedules_get", "Get a scheduled job", "app.schedules.get"),
  t("schedules", "schedules_create", "Create a scheduled job", "app.schedules.create"),
  t("schedules", "schedules_update", "Update a scheduled job", "app.schedules.update"),
  t("schedules", "schedules_pause", "Pause a scheduled job", "app.schedules.pause"),
  t("schedules", "schedules_resume", "Resume a scheduled job", "app.schedules.resume"),
  t("schedules", "schedules_run_now", "Trigger a scheduled job now", "app.schedules.runNow"),
  t("schedules", "schedules_delete", "Delete a scheduled job", "app.schedules.delete"),
  // Plans
  t("plans", "list_plans", "List plans, optional state filter", "app.plans.list"),
  t("plans", "get_plan", "Get a plan and its tasks", "app.plans.get"),
  t("plans", "create_plan", "Create a plan across repos", "app.plans.create"),
  t("plans", "update_plan", "Patch plan fields / repo set", "app.plans.update"),
  t("plans", "add_plan_repository", "Attach a repo to a plan", "app.plans.addRepository"),
  t("plans", "remove_plan_repository", "Detach a repo from a plan", "app.plans.removeRepository"),
  t("plans", "transition_plan", "Change plan state", "app.plans.transition"),
  t("plans", "delete_plan", "Delete a plan (cascades)", "app.plans.delete"),
  // Tasks
  t("tasks", "list_tasks", "List tasks by state/plan/assignee", "app.tasks.list"),
  t("tasks", "get_task", "Get full task details", "app.tasks.get"),
  t("tasks", "create_task", "Create a planned or standalone task", "app.tasks.create"),
  t("tasks", "update_task", "Patch task fields", "app.tasks.update"),
  t("tasks", "transition_task", "Change task state with note", "app.tasks.transition"),
  t("tasks", "set_task_pr", "Record a task's PR URL", "app.tasks.setPr"),
  t("tasks", "delete_task", "Delete a task (cascades)", "app.tasks.delete"),
  // Notes
  t("notes", "add_note", "Append a note to a task", "app.notes.add"),
  t("notes", "list_notes", "List a task's notes", "app.notes.list"),
  // Criteria
  t("criteria", "list_criteria", "List a task's criteria", "app.criteria.list"),
  t("criteria", "add_criterion", "Add a criterion", "app.criteria.add"),
  t("criteria", "check_criterion", "Mark a criterion done", "app.criteria.check"),
  t("criteria", "uncheck_criterion", "Mark a criterion not-done", "app.criteria.uncheck"),
  t("criteria", "update_criterion", "Edit a criterion by id", "app.criteria.update"),
  t("criteria", "delete_criterion", "Delete a criterion by id", "app.criteria.delete"),
  // Attachments
  t("attachments", "list_attachments", "List task/plan attachments", "app.attachments.list"),
  t("attachments", "get_attachment", "Fetch attachment bytes", "app.attachments.get"),
  t("attachments", "add_attachment", "Attach a text/binary artifact", "app.attachments.add"),
  t("attachments", "delete_attachment", "Delete an attachment", "app.attachments.delete"),
  // Agent sessions
  t("sessions", "list_sessions", "List agent sessions", "app.sessions.list"),
  t("sessions", "get_session", "Get a session and event tail", "app.sessions.get"),
  t("sessions", "start_session", "Start a background agent on a task", "app.sessions.start"),
  t("sessions", "await_session", "Legacy wait alias; new runs subscribe and receive conversation events", "app.sessions.await"),
  t("sessions", "cancel_session", "Cancel a running session", "app.sessions.cancel"),
  // Planning (planning profile)
  t("planning", "propose_spec", "Present a drafted spec for review", "app.planning.proposeSpec"),
  t("planning", "commit_spec_as_plan", "Save an approved spec as a draft plan", "app.planning.commitSpec"),
  t("planning", "propose_implementation_plan", "Present a task breakdown for review", "app.planning.proposePlan"),
  // Spawn (spawn profile)
  t("spawn", "spawn__spawn_agent", "Spawn a child agent run", "app.runs.spawn"),
  t("spawn", "spawn__get_run", "Poll a run's status/outcome", "app.runs.get"),
  t("spawn", "spawn__append_message", "Send a message to an existing run", "app.runs.appendMessage"),
  // Events / lifecycle (always-on)
  t("events", "timer__sleep", "Park the run and sleep", "app.timers.sleep"),
  t("events", "timer__set", "Schedule a future timer without parking", "app.timers.set"),
  t("events", "timer__cancel", "Cancel a pending timer", "app.timers.cancel"),
  t("events", "events__poll", "Inspect pending inbox events without acknowledging them", "app.events.poll"),
  t("events", "events__subscribe", "Subscribe to automatic run event messages", "app.events.subscribe"),
  t("events", "events__unsubscribe", "Stop a run event subscription", "app.events.unsubscribe"),
  t("events", "events__list_subscriptions", "List run event subscriptions", "app.events.listSubscriptions"),
  t("events", "events__emit", "Emit a custom event to a run in-tree", "app.events.emit"),
  t("events", "report_result", "Report a run's final result", "app.run.reportResult"),
  t("events", "raise", "Report a named exception", "app.run.raise"),
  t("events", "ask_parent", "Ask the parent run a question", "app.run.askParent"),
  t("events", "answer_question", "Answer a child's question", "app.run.answerQuestion"),
  // Memory
  t("memory", "memory_search", "BM25 search across memory scopes", "app.memory.search"),
  t("memory", "memory_remember", "Persist a durable memory", "app.memory.remember"),
  t("memory", "memory_forget", "Remove memory lines by match", "app.memory.forget"),
  // GitHub PR (gh_pr / gh_pr_ro)
  t("github", "gh_pr__pr_list", "List PRs", "app.github.pr.list"),
  t("github", "gh_repo__branches", "List branches (GitHub API)", "app.github.repo.branches"),
  t("github", "gh_pr__pr_view", "Fetch PR metadata", "app.github.pr.view"),
  t("github", "gh_pr__pr_diff", "Fetch a PR diff", "app.github.pr.diff"),
  t("github", "gh_pr__pr_comments", "Read PR comments", "app.github.pr.comments"),
  t("github", "gh_pr__pr_checks", "Read PR checks", "app.github.pr.checks"),
  t("github", "gh_pr__pr_review", "Post a PR review verdict", "app.github.pr.review"),
  t("github", "gh_pr__pr_comment", "Post a PR comment", "app.github.pr.comment"),
  t("github", "gh_pr__pr_merge", "Merge a PR", "app.github.pr.merge"),
  // GitHub CI (gh_ci)
  t("github", "gh_ci__ci_runs", "List workflow runs for a PR", "app.github.ci.runs"),
  t("github", "gh_ci__ci_logs", "Fetch trimmed workflow logs", "app.github.ci.logs"),
  t("github", "gh_ci__ci_rerun", "Trigger a fresh workflow run", "app.github.ci.rerun"),
  // Repo filesystem (repo_read / repo_write)
  t("repo_fs", "repo__list_files", "List tracked/untracked files", "app.repo.listFiles"),
  t("repo_fs", "repo__read_file", "Read a repo-relative file", "app.repo.readFile"),
  t("repo_fs", "repo__search", "git grep text search", "app.repo.search"),
  t("repo_fs", "repo__file_tree", "Directory tree", "app.repo.fileTree"),
  t("repo_fs", "repo__list_branches", "List local+remote branches", "app.repo.listBranches"),
  t("repo_fs", "repo__read_diff", "Read a local git diff", "app.repo.readDiff"),
  t("repo_fs", "repo__read_commits", "Read recent commits", "app.repo.readCommits"),
  t("repo_fs", "repo__show_commit", "Show one commit", "app.repo.showCommit"),
  t("repo_fs", "repo__blame", "git blame a file", "app.repo.blame"),
  // Search
  t("search", "brave__web_search", "Web search via Brave", "app.web.search"),

  // Internal tools NOT exposed to the guest SDK.
  x("memory", "memory__load", "Internal: load caller persona's memory (ambient skill)",
    "Ambient persona mechanism auto-loaded by the runner, not an agent-callable operation."),
  x("welfare", "welfare__load", "Internal: load caller's seat record + laurels (ambient skill)",
    "Ambient persona mechanism auto-loaded by the runner, not an agent-callable operation."),
];

// ---------------------------------------------------------------------------
// 2. REST routes — app/api/**/route.ts. Product handlers map to SDK methods
//    (many duplicate a tool: marked "alias" of the tool entry). Internal /
//    streaming / auth / system endpoints are excluded with reasons.
// ---------------------------------------------------------------------------

const REST_OPS: OperationEntry[] = [
  // Plans — overlap with tools.
  r("plans", "GET /api/plans", "List plans", "alias", { aliasOf: "tool:list_plans" }),
  r("plans", "POST /api/plans", "Create a plan", "alias", { aliasOf: "tool:create_plan" }),
  r("plans", "GET /api/plans/:id", "Get a plan + progress + tasks", "alias", { aliasOf: "tool:get_plan" }),
  r("plans", "PATCH /api/plans/:id", "Update a plan", "alias", { aliasOf: "tool:update_plan" }),
  r("plans", "DELETE /api/plans/:id", "Delete a plan", "alias", { aliasOf: "tool:delete_plan" }),
  r("plans", "POST /api/plans/:id/repositories", "Attach a repo to a plan", "alias", { aliasOf: "tool:add_plan_repository" }),
  r("plans", "DELETE /api/plans/:id/repositories/:repoId", "Detach a repo", "alias", { aliasOf: "tool:remove_plan_repository" }),
  r("attachments", "GET /api/plans/:id/attachments", "List plan attachments", "alias", { aliasOf: "tool:list_attachments" }),
  r("attachments", "POST /api/plans/:id/attachments", "Upload a plan attachment", "alias", { aliasOf: "tool:add_attachment" }),
  // Tasks
  r("tasks", "GET /api/tasks", "List tasks", "alias", { aliasOf: "tool:list_tasks" }),
  r("tasks", "POST /api/tasks", "Create a task", "alias", { aliasOf: "tool:create_task" }),
  r("tasks", "GET /api/tasks/:id", "Get a task", "alias", { aliasOf: "tool:get_task" }),
  r("tasks", "PATCH /api/tasks/:id", "Update a task", "alias", { aliasOf: "tool:update_task" }),
  r("tasks", "DELETE /api/tasks/:id", "Delete a task", "alias", { aliasOf: "tool:delete_task" }),
  r("tasks", "POST /api/tasks/:id/transition", "Transition a task", "alias", { aliasOf: "tool:transition_task" }),
  r("criteria", "POST /api/tasks/:id/criteria", "Add a criterion", "alias", { aliasOf: "tool:add_criterion" }),
  r("criteria", "PATCH /api/tasks/:id/criteria/:cid", "Update a criterion", "alias", { aliasOf: "tool:update_criterion" }),
  r("criteria", "DELETE /api/tasks/:id/criteria/:cid", "Delete a criterion", "alias", { aliasOf: "tool:delete_criterion" }),
  r("notes", "POST /api/tasks/:id/notes", "Append a note", "alias", { aliasOf: "tool:add_note" }),
  r("attachments", "GET /api/tasks/:id/attachments", "List task attachments", "alias", { aliasOf: "tool:list_attachments" }),
  r("attachments", "POST /api/tasks/:id/attachments", "Upload a task attachment", "alias", { aliasOf: "tool:add_attachment" }),
  r("sessions", "GET /api/tasks/:id/sessions", "List a task's sessions", "alias", { aliasOf: "tool:list_sessions" }),
  r("sessions", "POST /api/tasks/:id/sessions", "Start a session on a task", "alias", { aliasOf: "tool:start_session" }),
  r("tasks", "GET /api/tasks/:id/mergeable", "Report PR mergeability of a task", "sdk", { sdk: "app.tasks.mergeable" }),
  r("tasks", "POST /api/tasks/:id/attached-run", "Open-or-create a task's attached run", "sdk", { sdk: "app.tasks.attachedRun" }),
  // Runs
  r("runs", "POST /api/runs", "Create a run", "sdk", { sdk: "app.runs.create" }),
  r("runs", "GET /api/runs/:id", "Get a run + messages", "alias", { aliasOf: "tool:spawn__get_run" }),
  r("runs", "PATCH /api/runs/:id", "Run actions: close/cancel/configure", "sdk", { sdk: "app.runs.control" }),
  r("runs", "POST /api/runs/:id/planning", "Approve a planning stage", "sdk", { sdk: "app.runs.approvePlanning" }),
  r("runs", "GET /api/runs/:id/inbox", "Read a run's inbox-event trail", "sdk", { sdk: "app.runs.inbox" }),
  // Sessions (legacy agent-session surface)
  r("sessions", "GET /api/sessions", "List agent sessions", "alias", { aliasOf: "tool:list_sessions" }),
  r("sessions", "GET /api/sessions/:id", "Get a session + events", "alias", { aliasOf: "tool:get_session" }),
  r("sessions", "POST /api/sessions/:id/cancel", "Cancel a session", "alias", { aliasOf: "tool:cancel_session" }),
  r("sessions", "POST /api/sessions/:id/resume", "Resume a prior session", "sdk", { sdk: "app.sessions.resume" }),
  // Schedules
  r("schedules", "GET /api/schedules", "List schedules", "sdk", { sdk: "app.schedules.list" }),
  r("schedules", "POST /api/schedules", "Create a schedule", "sdk", { sdk: "app.schedules.create" }),
  r("schedules", "GET /api/schedules/:id", "Get a schedule", "sdk", { sdk: "app.schedules.get" }),
  r("schedules", "PATCH /api/schedules/:id", "Update a schedule", "sdk", { sdk: "app.schedules.update" }),
  r("schedules", "DELETE /api/schedules/:id", "Delete a schedule", "sdk", { sdk: "app.schedules.delete" }),
  r("schedules", "POST /api/schedules/:id/pause", "Pause a schedule", "sdk", { sdk: "app.schedules.pause" }),
  r("schedules", "POST /api/schedules/:id/resume", "Resume a schedule", "sdk", { sdk: "app.schedules.resume" }),
  r("schedules", "POST /api/schedules/:id/run", "Trigger a schedule now", "sdk", { sdk: "app.schedules.runNow" }),
  // Chats
  r("chats", "GET /api/chats", "List the user's chats", "sdk", { sdk: "app.chats.list" }),
  r("chats", "POST /api/chats", "Create a chat", "sdk", { sdk: "app.chats.create" }),
  r("chats", "GET /api/chats/:id", "Get a chat + messages", "sdk", { sdk: "app.chats.get" }),
  r("chats", "PATCH /api/chats/:id", "Update chat settings", "sdk", { sdk: "app.chats.update" }),
  r("chats", "DELETE /api/chats/:id", "Delete a chat", "sdk", { sdk: "app.chats.delete" }),
  // Repositories
  r("repositories", "GET /api/repositories", "List repositories", "alias", { aliasOf: "tool:list_repositories" }),
  r("repositories", "POST /api/repositories", "Create a repository", "alias", { aliasOf: "tool:create_repository" }),
  r("repositories", "GET /api/repositories/:id", "Get a repository", "alias", { aliasOf: "tool:get_repository" }),
  r("repositories", "PATCH /api/repositories/:id", "Update a repository", "alias", { aliasOf: "tool:update_repository" }),
  r("repositories", "DELETE /api/repositories/:id", "Delete a repository", "alias", { aliasOf: "tool:delete_repository" }),
  // Personas / config catalogs
  r("personas", "GET /api/personas", "List personas", "sdk", { sdk: "app.personas.list" }),
  r("personas", "PATCH /api/personas/:id", "Update a persona", "sdk", { sdk: "app.personas.update" }),
  r("personas", "POST /api/personas/:id", "Reset a persona to default", "sdk", { sdk: "app.personas.reset" }),
  r("personas", "GET /api/personas/:id/laurels", "Get a persona's seat + laurels", "sdk", { sdk: "app.personas.laurels" }),
  r("personas", "POST /api/personas/:id/laurels", "Award a laurel", "sdk", { sdk: "app.personas.awardLaurel" }),
  r("config", "GET /api/assignees", "Assignee autocomplete catalog", "sdk", { sdk: "app.config.assignees" }),
  r("config", "GET /api/providers", "Provider/model catalog", "sdk", { sdk: "app.config.providers" }),
  r("config", "GET /api/tools-profiles", "Tool-profile catalog", "sdk", { sdk: "app.config.toolsProfiles" }),
  // API tokens
  r("config", "GET /api/tokens", "List the user's API tokens", "sdk", { sdk: "app.tokens.list" }),
  r("config", "POST /api/tokens", "Create an API token", "sdk", { sdk: "app.tokens.create" }),
  r("config", "DELETE /api/tokens/:id", "Revoke an API token", "sdk", { sdk: "app.tokens.revoke" }),
  // Codex OAuth (config)
  r("config", "GET /api/codex", "Codex credential status", "sdk", { sdk: "app.codex.status" }),
  r("config", "POST /api/codex", "Start a Codex device login", "sdk", { sdk: "app.codex.startLogin" }),
  r("config", "PUT /api/codex", "Exchange the Codex device code", "sdk", { sdk: "app.codex.completeLogin" }),
  r("config", "DELETE /api/codex", "Sign out of Codex", "sdk", { sdk: "app.codex.logout" }),
  // Discord integration (config)
  r("integration", "GET /api/discord/bots", "List Discord bot statuses", "sdk", { sdk: "app.discord.listBots" }),
  r("integration", "POST /api/discord/bots", "Create/replace a persona's bot", "sdk", { sdk: "app.discord.upsertBot" }),
  r("integration", "PATCH /api/discord/bots/:personaId", "Update a bot", "sdk", { sdk: "app.discord.updateBot" }),
  r("integration", "DELETE /api/discord/bots/:personaId", "Remove a bot", "sdk", { sdk: "app.discord.removeBot" }),
  r("integration", "GET /api/discord/identity", "Get the caller's Discord identity", "sdk", { sdk: "app.discord.getIdentity" }),
  r("integration", "PUT /api/discord/identity", "Set the caller's Discord id", "sdk", { sdk: "app.discord.setIdentity" }),
  r("integration", "DELETE /api/discord/identity", "Unlink Discord identity", "sdk", { sdk: "app.discord.unlinkIdentity" }),
  r("integration", "POST /api/discord/verify", "Verify a pasted bot token", "sdk", { sdk: "app.discord.verifyToken" }),
  r("integration", "GET /api/discord/verify", "Re-check a stored bot", "sdk", { sdk: "app.discord.recheckBot" }),
  // Attachments (content serving)
  r("attachments", "GET /api/attachments/:id", "Serve attachment bytes", "alias", { aliasOf: "tool:get_attachment" }),
  r("attachments", "DELETE /api/attachments/:id", "Delete an attachment", "alias", { aliasOf: "tool:delete_attachment" }),
  // Users / auth (CLI-owned; see users domain). Managed via CLI, no dedicated REST.

  // --- Excluded REST endpoints ---
  rx("auth", "GET|POST /api/auth/[...nextauth]", "NextAuth sign-in handlers",
    "Auth framework callback; identity is established out-of-band, not a guest operation."),
  rx("auth", "POST /api/auth/magic-link", "Request a magic-link login",
    "Auth bootstrap; must stay outside the sandbox (credential issuance)."),
  rx("system", "POST /api/mcp", "MCP JSON-RPC transport over Streamable HTTP",
    "External-client transport that itself EXPOSES the tool registry; preserved as the MCP contract, not re-wrapped as a guest op."),
  rx("system", "GET /api/mcp", "MCP setup-hint 405",
    "Transport metadata for MCP clients."),
  rx("system", "POST /api/github/webhook", "GitHub webhook receiver",
    "HMAC-authenticated inbound webhook; server ingress, not an agent-initiated operation."),
  r("system", "GET /api/health", "Read service health diagnostics", "sdk", { sdk: "app.diagnostics.health" }),
  r("system", "GET /api/metrics", "Read bounded service metrics", "sdk", { sdk: "app.diagnostics.metrics" }),
  rx("system", "GET /api/worker-bundle", "Serve the worker bundle tarball",
    "Infrastructure bootstrap for sprite workers; not a product operation."),
  r("system", "POST /api/environments/build", "Start a worker environment build", "sdk", { sdk: "app.environments.build" }),
  r("runs", "GET /api/runs/:id/events", "Read a run's event stream snapshot", "sdk", { sdk: "app.runs.events" }),
  r("runs", "POST /api/runs/:id/messages", "Send a message to a run", "sdk", { sdk: "app.runs.messages" }),
  rx("runs", "GET /api/runs/:id/worker-log", "Fetch worker/container output",
    "Operational debugging surface for humans; not a product operation."),
  rx("runs", "GET /api/runs/overview", "Aggregate run/chat index rows",
    "UI polling projection; the guest reads runs individually via app.runs.get."),
  rx("runs", "GET /api/runs/overview/events", "SSE run-overview push feed",
    "SSE streaming projection for the UI."),
  r("sessions", "GET /api/sessions/:id/events", "Read a session's event stream snapshot", "sdk", { sdk: "app.sessions.events" }),
  r("chats", "POST /api/chats/:id/messages", "Send a message to an owned chat", "sdk", { sdk: "app.chats.messages" }),
  rx("system", "GET /api/inbox", "Global needs-you inbox projection",
    "Cross-run UI projection for humans; guest uses events__subscribe within its own tree."),
  rx("system", "GET /api/live-sessions", "Live sidebar projection",
    "UI projection for the sidebar; not a product operation."),
];

// ---------------------------------------------------------------------------
// 3. CLI commands — cli.ts. Most duplicate a tool or a schedule REST op.
// ---------------------------------------------------------------------------

const CLI_OPS: OperationEntry[] = [
  c("tasks", "list", "List tasks", "alias", { aliasOf: "tool:list_tasks" }),
  c("tasks", "show", "Show a task or plan", "alias", { aliasOf: "tool:get_task" }),
  c("tasks", "new task", "Create a task", "alias", { aliasOf: "tool:create_task" }),
  c("tasks", "transition", "Transition a task", "alias", { aliasOf: "tool:transition_task" }),
  c("notes", "note", "Append a note to a task", "alias", { aliasOf: "tool:add_note" }),
  c("plans", "plans", "List plans", "alias", { aliasOf: "tool:list_plans" }),
  c("plans", "new plan", "Create a plan", "alias", { aliasOf: "tool:create_plan" }),
  c("plans", "plan-state", "Transition a plan", "alias", { aliasOf: "tool:transition_plan" }),
  c("criteria", "crit add", "Add a criterion", "alias", { aliasOf: "tool:add_criterion" }),
  c("criteria", "crit done", "Mark a criterion done", "alias", { aliasOf: "tool:check_criterion" }),
  c("criteria", "crit undone", "Mark a criterion not-done", "alias", { aliasOf: "tool:uncheck_criterion" }),
  c("criteria", "crit rm", "Remove a criterion", "alias", { aliasOf: "tool:delete_criterion" }),
  c("attachments", "attach add", "Attach a file", "alias", { aliasOf: "tool:add_attachment" }),
  c("attachments", "attach list", "List attachments", "alias", { aliasOf: "tool:list_attachments" }),
  c("attachments", "attach get", "Write attachment bytes to a file", "alias", { aliasOf: "tool:get_attachment" }),
  c("attachments", "attach rm", "Delete an attachment", "alias", { aliasOf: "tool:delete_attachment" }),
  c("sessions", "agent", "Start an agent session on a task", "alias", { aliasOf: "tool:start_session" }),
  c("sessions", "agent list", "List agent sessions", "alias", { aliasOf: "tool:list_sessions" }),
  c("sessions", "agent cancel", "Cancel a session", "alias", { aliasOf: "tool:cancel_session" }),
  c("sessions", "agent resume", "Resume a session", "alias", { aliasOf: "rest:POST /api/sessions/:id/resume" }),
  c("schedules", "schedule list", "List schedules", "alias", { aliasOf: "rest:GET /api/schedules" }),
  c("schedules", "schedule show", "Show a schedule", "alias", { aliasOf: "rest:GET /api/schedules/:id" }),
  c("schedules", "schedule create", "Create a schedule", "alias", { aliasOf: "rest:POST /api/schedules" }),
  c("schedules", "schedule update", "Update a schedule", "alias", { aliasOf: "rest:PATCH /api/schedules/:id" }),
  c("schedules", "schedule pause", "Pause a schedule", "alias", { aliasOf: "rest:POST /api/schedules/:id/pause" }),
  c("schedules", "schedule resume", "Resume a schedule", "alias", { aliasOf: "rest:POST /api/schedules/:id/resume" }),
  c("schedules", "schedule run", "Trigger a schedule now", "alias", { aliasOf: "rest:POST /api/schedules/:id/run" }),
  c("schedules", "schedule delete", "Delete a schedule", "alias", { aliasOf: "rest:DELETE /api/schedules/:id" }),
  // Users — no REST/tool equivalent today; needs an SDK admin capability.
  c("users", "user list", "List sign-in users", "sdk", { sdk: "app.admin.users.list" }),
  c("users", "user add", "Create a user", "sdk", { sdk: "app.admin.users.create" }),
  c("users", "user passwd", "Set a user's password", "sdk", { sdk: "app.admin.users.setPassword" }),
  c("users", "user link", "Generate a magic login link", "sdk", { sdk: "app.admin.users.magicLink" }),
  c("users", "user rm", "Delete a user", "sdk", { sdk: "app.admin.users.delete" }),
  // Codex OAuth — CLI mirror of /api/codex.
  c("config", "codex login", "Codex device login", "alias", { aliasOf: "rest:POST /api/codex" }),
  c("config", "codex logout", "Codex logout", "alias", { aliasOf: "rest:DELETE /api/codex" }),
  c("config", "codex status", "Codex status", "alias", { aliasOf: "rest:GET /api/codex" }),
  // Meta
  cx("system", "help", "Print CLI usage", "Local CLI help text; no product effect."),
];

// ---------------------------------------------------------------------------
// 4. UI / server actions. The app uses NO Next.js server actions: every
//    UI-driven mutation goes through the REST routes above via client `fetch`.
//    Recorded explicitly so the "UI/server actions" surface is accounted for
//    rather than silently empty.
// ---------------------------------------------------------------------------

const UI_OPS: OperationEntry[] = [
  {
    id: "ui:none",
    surface: "ui_action",
    domain: "system",
    name: "(no server actions)",
    description:
      "The Next.js app defines zero server actions ('use server'); all UI mutations call the REST routes enumerated above. No distinct UI-only operation exists.",
    coverage: "excluded",
    exclusionReason:
      "No server-action surface exists — UI operations are already covered by their REST entries.",
  },
];

// ---------------------------------------------------------------------------
// 5. Compatibility name aliases retained during migration (plan "Agent-facing
//    API": `tools` = compatibility aliases; agent.ts re-registers ORCHESTRATOR
//    tools with a `task_orch__` prefix). These are alternate NAMES for tool
//    entries, not new operations.
// ---------------------------------------------------------------------------

const ORCHESTRATOR_BARE_NAMES = new Set<string>([
  "list_repositories", "get_repository", "create_repository", "update_repository", "delete_repository",
  "list_plans", "get_plan", "create_plan", "update_plan", "add_plan_repository", "remove_plan_repository",
  "transition_plan", "delete_plan",
  "list_tasks", "get_task", "create_task", "update_task", "transition_task", "set_task_pr", "delete_task",
  "add_note", "list_notes",
  "list_criteria", "add_criterion", "check_criterion", "uncheck_criterion", "update_criterion", "delete_criterion",
  "list_attachments", "get_attachment", "add_attachment", "delete_attachment",
  "list_sessions", "get_session", "start_session", "await_session", "cancel_session",
]);

const ORCHESTRATOR_PREFIXED = TOOL_OPS
  .filter((e) => e.coverage === "sdk" && isOrchestratorBare(e.name))
  .map((e) =>
    alias("tool", e.domain, `task_orch__${e.name}`, `pi-extension prefixed alias of ${e.name}`, `tool:${e.name}`),
  );

const TOOLS_COMPAT_ALIASES = TOOL_OPS
  .filter((e) => e.coverage === "sdk")
  .map((e) =>
    alias("tool", e.domain, `tools.${e.name}`, `CodeAct compat alias of ${e.name}`, `tool:${e.name}`),
  );

// Harness-provided built-in file/search/shell tools (lib/builtin-tools.ts
// canonical identities). Not part of the `app` SDK: authorized filesystem/shell
// access is an explicit worker-side capability in the run's validated worktree
// (plan "Runtime decision"), and read access is additionally mirrored by the
// repo_fs SDK methods. Recorded as excluded so their name-aliases resolve and
// the surface is accounted for.
const BUILTIN_CANONICAL: OperationEntry[] = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "Agent",
].map((name) => ({
  id: `tool:builtin:${name}`,
  surface: "tool" as const,
  domain: name === "WebSearch" || name === "WebFetch" ? ("search" as const) : ("repo_fs" as const),
  name,
  description: `Harness built-in tool: ${name}`,
  coverage: "excluded" as const,
  exclusionReason:
    "Harness-provided built-in; authorized fs/shell is a worker-side capability, not part of the app SDK surface.",
}));

const BUILTIN_NAME_ALIASES: OperationEntry[] = [
  // lib/builtin-tools.ts RAW_TO_CANONICAL — harness built-ins, name-normalized.
  alias("tool", "repo_fs", "multiedit", "Built-in alias → Edit", "tool:builtin:Edit"),
  alias("tool", "repo_fs", "notebookedit", "Built-in alias → Edit", "tool:builtin:Edit"),
  alias("tool", "repo_fs", "bashoutput", "Built-in alias → Bash", "tool:builtin:Bash"),
  alias("tool", "repo_fs", "ripgrep", "Built-in alias → Grep", "tool:builtin:Grep"),
  alias("tool", "repo_fs", "rg", "Built-in alias → Grep", "tool:builtin:Grep"),
  alias("tool", "repo_fs", "find", "Built-in alias → Glob", "tool:builtin:Glob"),
  alias("tool", "repo_fs", "fd", "Built-in alias → Glob", "tool:builtin:Glob"),
  alias("tool", "repo_fs", "tree", "Built-in alias → LS", "tool:builtin:LS"),
  // Sub-agent spawning, per harness (lib/subagent-tools.ts): Claude's legacy
  // `Task` spelling and Codex's `spawn_agent` (v2) / `multi_agent_v1.spawn_agent`.
  alias("tool", "repo_fs", "task", "Built-in alias → Agent", "tool:builtin:Agent"),
  alias("tool", "repo_fs", "spawn_agent", "Built-in alias → Agent", "tool:builtin:Agent"),
  alias("tool", "repo_fs", "multi_agent_v1.spawn_agent", "Built-in alias → Agent", "tool:builtin:Agent"),
];

// ---------------------------------------------------------------------------
// Assembled manifest + accessors.
// ---------------------------------------------------------------------------

export const OPERATION_MANIFEST: readonly OperationEntry[] = [
  ...TOOL_OPS,
  ...REST_OPS,
  ...CLI_OPS,
  ...UI_OPS,
  ...BUILTIN_CANONICAL,
  ...ORCHESTRATOR_PREFIXED,
  ...TOOLS_COMPAT_ALIASES,
  ...BUILTIN_NAME_ALIASES,
];

export interface CoverageSummary {
  total: number;
  bySurface: Record<OperationSurface, number>;
  byCoverage: Record<CoverageClass, number>;
  /** Distinct proposed SDK namespaces (coverage === "sdk"). */
  sdkNamespaces: number;
}

export function summarizeCoverage(
  entries: readonly OperationEntry[] = OPERATION_MANIFEST,
): CoverageSummary {
  const bySurface = { rest: 0, cli: 0, tool: 0, ui_action: 0 } as Record<OperationSurface, number>;
  const byCoverage = { sdk: 0, alias: 0, excluded: 0 } as Record<CoverageClass, number>;
  const namespaces = new Set<string>();
  for (const e of entries) {
    bySurface[e.surface]++;
    byCoverage[e.coverage]++;
    if (e.coverage === "sdk" && e.sdkNamespace) namespaces.add(e.sdkNamespace);
  }
  return {
    total: entries.length,
    bySurface,
    byCoverage,
    sdkNamespaces: namespaces.size,
  };
}

// ---------------------------------------------------------------------------
// Builders (keep the data tables terse and consistent).
// ---------------------------------------------------------------------------

function t(domain: OperationDomain, name: string, description: string, sdk: string): OperationEntry {
  return { id: `tool:${name}`, surface: "tool", domain, name, description, coverage: "sdk", sdkNamespace: sdk };
}
function x(domain: OperationDomain, name: string, description: string, reason: string): OperationEntry {
  return { id: `tool:${name}`, surface: "tool", domain, name, description, coverage: "excluded", exclusionReason: reason };
}
function r(
  domain: OperationDomain,
  name: string,
  description: string,
  coverage: CoverageClass,
  opts: { sdk?: string; aliasOf?: string },
): OperationEntry {
  return {
    id: `rest:${name}`,
    surface: "rest",
    domain,
    name,
    description,
    coverage,
    sdkNamespace: opts.sdk,
    aliasOf: opts.aliasOf,
  };
}
function rx(domain: OperationDomain, name: string, description: string, reason: string): OperationEntry {
  return { id: `rest:${name}`, surface: "rest", domain, name, description, coverage: "excluded", exclusionReason: reason };
}
function c(
  domain: OperationDomain,
  name: string,
  description: string,
  coverage: CoverageClass,
  opts: { sdk?: string; aliasOf?: string },
): OperationEntry {
  return {
    id: `cli:${name}`,
    surface: "cli",
    domain,
    name,
    description,
    coverage,
    sdkNamespace: opts.sdk,
    aliasOf: opts.aliasOf,
  };
}
function cx(domain: OperationDomain, name: string, description: string, reason: string): OperationEntry {
  return { id: `cli:${name}`, surface: "cli", domain, name, description, coverage: "excluded", exclusionReason: reason };
}
function alias(
  surface: OperationSurface,
  domain: OperationDomain,
  name: string,
  description: string,
  aliasOf: string,
): OperationEntry {
  return { id: `${surface}:${name}`, surface, domain, name, description, coverage: "alias", aliasOf };
}

/** ORCHESTRATOR_TOOLS bare names — the set re-registered with a `task_orch__`
 *  prefix by lib/extensions/agent.ts. */
function isOrchestratorBare(name: string): boolean {
  return ORCHESTRATOR_BARE_NAMES.has(name);
}
