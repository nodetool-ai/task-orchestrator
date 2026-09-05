// lib/config.ts
//
// The single reader for every TASK_ORCH_* environment variable and the one
// place the "flag" truthiness convention, numeric parsing, and cross-flag
// derivations live. Before this module those were re-implemented ad hoc across
// lib/, db/, and scripts/ — a truthiness predicate copied a dozen times, the
// 5-minute stale window written three times and remote-provider defaults
// buried in three functions.
//
// DESIGN — lazy, not frozen-at-import. Every accessor reads process.env at CALL
// time, because the test suite mutates process.env per-test and expects the
// change to take effect (dozens of sites). The win here is therefore NOT an
// import-time snapshot; it is: one parsing convention, one derivation, one
// documented registry. `snapshot()` returns a frozen plain-value copy for
// logging/telemetry — never read it in hot control-flow, it will not reflect a
// later env mutation.
//
// CONVENTIONS
//  - `truthy(v)`  — a flag that DEFAULTS OFF: on iff set and not "0"/"false".
//  - `flag(k,d)`  — `d` is the value when the var is UNSET. Preserves both of
//                   the historical conventions exactly (default-off vs the
//                   default-ON flags like ADMISSION_ENABLED).
//  - `intEnv`     — finite → floor, else default (negatives pass through, as the
//                   dispatch tuning readers always did; they are counts where a
//                   negative is a config error, not a sentinel).
//
// Any file still reading process.env.TASK_ORCH_* directly is tracked by the
// guard test in __tests__/config-guard.test.ts; that allowlist only shrinks.

import { createHash } from "node:crypto";

/** Short, stable identifier for the database this process is a control plane
 *  for. Sockets live in a shared /tmp dir keyed only by uid, so two checkouts
 *  or dev servers pointed at DIFFERENT databases would otherwise collide and
 *  the socket sweeper (which only knows its own DB) would unlink the other's
 *  live sockets. Namespacing the dir by the database URL keeps each control
 *  plane's sockets isolated. Empty when DATABASE_URL is unset (e.g. workers);
 *  they don't own the dir, so a shared default namespace is harmless. */
function dbNamespace(): string {
  const url = process.env.DATABASE_URL ?? "";
  return createHash("sha1").update(url).digest("hex").slice(0, 10);
}

/** A flag that defaults OFF: true iff set to something other than "0"/"false"
 *  (case-insensitive). The convention copied across the codebase pre-R6. */
export function truthy(v: string | undefined | null): boolean {
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Read a boolean flag. `dflt` is the value when the variable is UNSET.
 *  - dflt=false → historical `truthy()` convention (absent ⇒ off).
 *  - dflt=true  → the default-ON convention (`v == null || not "0"/"false"`),
 *    used by ADMISSION_ENABLED.
 * Both branches reproduce the exact pre-R6 predicates (including empty-string:
 * "" ⇒ off under default-off, "" ⇒ on under default-on).
 */
export function flag(key: string, dflt: boolean): boolean {
  const v = process.env[key];
  if (dflt) return v == null || (v !== "0" && v.toLowerCase() !== "false");
  return truthy(v);
}

/** Non-negative-ish integer env: finite → floor, else `dflt`. Mirrors the
 *  dispatch tuning reader (negatives floor through — a negative count is a
 *  config error, not a sentinel). */
export function intEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
}

/** Float env: finite → value, else `dflt`. */
export function floatEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/** Trimmed string env, or `dflt` (default undefined) when unset/empty. */
function strEnv(key: string): string | undefined;
function strEnv(key: string, dflt: string): string;
function strEnv(key: string, dflt?: string): string | undefined {
  const v = process.env[key];
  return v == null || v === "" ? dflt : v;
}

export type RunnerProviderKind = "local" | "sprites";
export type NestedDispatchMode = "isolate" | "inline";

// ── Derived values (were duplicated across modules) ────────────────────────

/** The execution backend. Exact-equality on a supported remote provider (NOT
 *  truthiness): any other value — including "local", "docker", "" — means
 *  the local provider. `fly` is explicitly rejected so stale configuration
 *  cannot silently run workloads on the local host. */
export function runnerProviderKind(): RunnerProviderKind {
  switch (process.env.TASK_ORCH_RUNNER) {
    case "fly":
      throw new Error("TASK_ORCH_RUNNER=fly is no longer supported; use 'local' or 'sprites'");
    case "sprites":
      return "sprites";
    default:
      return "local";
  }
}

/** True inside a worker process (Sprite / Docker worker container).
 *  The Sprite bootstrap and worker container config set
 *  TASK_ORCH_INSIDE_WORKER=1. A worker holds no cloud credentials and none of the
 *  admission/pump/sweep machinery, so this gates the nested-dispatch branch and
 *  the DB guard (workers never touch Postgres). */
export function insideWorker(): boolean {
  return truthy(process.env.TASK_ORCH_INSIDE_WORKER);
}

/**
 * True when user turns run out-of-process (detached worker per turn).
 * INTERACTION: managed remote providers FORCE this on — their deployments are
 * detached by construction — so an unset/"0" TASK_ORCH_DETACHED_RUNS is
 * overridden to true whenever a remote provider is selected. Local execution
 * uses the plain flag.
 */
export function detachedRunsEnabled(): boolean {
  if (runnerProviderKind() !== "local") return true;
  return truthy(process.env.TASK_ORCH_DETACHED_RUNS);
}

/**
 * Nested-dispatch policy for a run created INSIDE a worker (see
 * docs/nested-machine-dispatch.md, Decision 5, and lib/runner/provider.ts for
 * the long form).
 *  1. Explicit TASK_ORCH_NESTED_DISPATCH "isolate"/"inline" (case-insensitive)
 *     wins; any other value falls through.
 *  2. Default: "isolate" on a managed remote provider, else "inline".
 * INTERACTION: inside a worker the value arrives already RESOLVED via
 * worker bootstrap (workers never set TASK_ORCH_RUNNER), so the env passthrough
 * — not this default — is what turns isolation on inside the worker.
 */
export function nestedDispatchMode(): NestedDispatchMode {
  const raw = process.env.TASK_ORCH_NESTED_DISPATCH;
  if (raw) {
    const v = raw.toLowerCase();
    if (v === "isolate") return "isolate";
    if (v === "inline") return "inline";
  }
  return runnerProviderKind() === "local" ? "inline" : "isolate";
}

// ── Grouped registry ───────────────────────────────────────────────────────
// Getters read process.env lazily on each access. Grouped by concern; each
// entry is the documented home of that flag. Object.freeze prevents structural
// mutation, not getter evaluation.

export const config = Object.freeze({
  /** Deployment / execution backend. */
  deployment: Object.freeze({
    /** "local" | "sprites". @see runnerProviderKind */
    get runnerKind(): RunnerProviderKind {
      return runnerProviderKind();
    },
    /** Out-of-process turns; managed remote providers force on. @see detachedRunsEnabled */
    get detachedRuns(): boolean {
      return detachedRunsEnabled();
    },
    /** Docker worker image; presence ⇒ Docker-worker mode (spawn containers). */
    get workerImage(): string | undefined {
      return strEnv("TASK_ORCH_WORKER_IMAGE");
    },
    /** Distinguishes co-located orchestrator instances for container naming. */
    get instanceId(): string | undefined {
      return strEnv("TASK_ORCH_INSTANCE_ID");
    },
    /** Docker network to attach worker containers to. */
    get dockerNetwork(): string | undefined {
      return strEnv("TASK_ORCH_DOCKER_NETWORK");
    },
    /** Host ~/.claude mount for worker containers. */
    get claudeHomeHost(): string | undefined {
      return strEnv("TASK_ORCH_CLAUDE_HOME_HOST");
    },
    /** Host volume / dir for the shared repo cache. */
    get repoCacheHostVolume(): string | undefined {
      return strEnv("TASK_ORCH_REPO_CACHE_HOST_VOLUME");
    },
    get repoCacheDir(): string | undefined {
      return strEnv("TASK_ORCH_REPO_CACHE_DIR");
    },
    /** Shallow-clone depth for in-runner repo checkouts. Default `1` fetches
     *  only the latest commit per branch, so a cold clone moves far less of a
     *  long-history repo; `0` (or negative) restores a full-history clone.
     *  @see containerCheckoutAt in lib/runs.ts */
    get gitCloneDepth(): number {
      return intEnv("TASK_ORCH_GIT_CLONE_DEPTH", 1);
    },
    /** tsx CLI path for the worker entrypoint (test/dev override). */
    get tsxCli(): string | undefined {
      return strEnv("TASK_ORCH_TSX_CLI");
    },
  }),

  /** Worker identity + transport (set on the worker process by dispatch). */
  worker: Object.freeze({
    /** This process is a run worker. @see insideWorker */
    get inside(): boolean {
      return insideWorker();
    },
    /** How a worker-spawned child gets its runner. @see nestedDispatchMode */
    get nestedDispatch(): NestedDispatchMode {
      return nestedDispatchMode();
    },
    /** Remote repo + ref the worker build SHA resolves from (git ls-remote);
     *  identifies which worker code an execution artifact must contain. */
    get repoUrl(): string {
      return strEnv("TASK_ORCH_WORKER_REPO_URL", "https://github.com/nodetool-ai/task-orchestrator.git") as string;
    },
    get repoRef(): string {
      return strEnv("TASK_ORCH_WORKER_REPO_REF", "main") as string;
    },
    get channelInstanceId(): string | undefined {
      return strEnv("TASK_ORCH_WORKER_INSTANCE_ID");
    },
    get channelCredential(): string | undefined {
      return strEnv("TASK_ORCH_WORKER_CHANNEL_CREDENTIAL");
    },
    get channelEndpoint(): string | undefined {
      return strEnv("TASK_ORCH_WORKER_CHANNEL_ENDPOINT");
    },
    /** HMAC secret channel instance credentials are derived from (control plane). */
    get channelSecret(): string | undefined {
      return strEnv("TASK_ORCH_WORKER_CHANNEL_SECRET");
    },
    /** Dead-worker backstop: exit when no controller has been attached for this
     *  long, so a worker that is never dialed (run 169) stops holding its Fly
     *  Machine open at full price. 0 disables — use that for a long manual or
     *  debugging session you do not want killed at the 10-minute mark. */
    get idleExitMs(): number {
      return intEnv("TASK_ORCH_WORKER_IDLE_EXIT_MS", 600_000);
    },
    /** Directory for local workers' Unix-domain sockets. MUST stay short: the
     *  kernel caps sun_path at ~104-108 bytes, and a cwd-derived path already
     *  overflowed on GitHub runners (110 chars → listen EINVAL, the red-CI
     *  incident of 2026-07-17). Default is /tmp-based and cwd-independent, and
     *  namespaced by the control plane's database so co-located instances on
     *  different DBs never share a dir (the sweeper only knows its own DB and
     *  would otherwise unlink another instance's live sockets). */
    get socketDir(): string {
      const override = strEnv("TASK_ORCH_SOCKET_DIR");
      if (override) return override;
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      return `/tmp/task-orch-${uid}-${dbNamespace()}`;
    },
    /** Worker build identifier reported in channel.hello. */
    get build(): string | undefined {
      return strEnv("TASK_ORCH_WORKER_BUILD");
    },
    /** Verbose channel-frame logging (TASK_ORCH_LOG_LEVEL=debug). */
    get debugLog(): boolean {
      return strEnv("TASK_ORCH_LOG_LEVEL")?.toLowerCase() === "debug";
    },
    /** Existing checkout supplied by a managed runner snapshot. */
    get runnerRepoPath(): string | undefined {
      return strEnv("TASK_ORCH_RUNNER_REPO_PATH");
    },
    /** Test-only escape hatch: let a simulated worker env touch Postgres. */
    get allowDb(): boolean {
      return truthy(process.env.TASK_ORCH_WORKER_ALLOW_DB);
    },
    get cpus(): number {
      return intEnv("TASK_ORCH_WORKER_CPUS", 0);
    },
    get memoryMb(): number {
      return intEnv("TASK_ORCH_WORKER_MEMORY_MB", 0);
    },
    get memorySwapMb(): number {
      return intEnv("TASK_ORCH_WORKER_MEMORY_SWAP_MB", 0);
    },
    get memoryReservationMb(): number {
      return intEnv("TASK_ORCH_WORKER_MEMORY_RESERVATION_MB", 0);
    },
    get pidsLimit(): number {
      return intEnv("TASK_ORCH_WORKER_PIDS_LIMIT", 0);
    },
  }),

  /** Dispatch / admission / pump tuning. */
  dispatch: Object.freeze({
    /** Admission-gate feature flag (default ON; further gated by provider —
     *  see admission logic in lib/run-dispatch.ts). */
    get admissionFlag(): boolean {
      return flag("TASK_ORCH_ADMISSION_ENABLED", true);
    },
    get maxWorkers(): number {
      return intEnv("TASK_ORCH_MAX_WORKERS", 0);
    },
    get hostMemoryReserveMb(): number {
      return intEnv("TASK_ORCH_HOST_MEMORY_RESERVE_MB", 0);
    },
    get maxRunDepth(): number {
      return intEnv("TASK_ORCH_MAX_RUN_DEPTH", 3);
    },
    get maxTreeRuns(): number {
      return intEnv("TASK_ORCH_MAX_TREE_RUNS", 32);
    },
    get treeBudgetMult(): number {
      const value = floatEnv("TASK_ORCH_TREE_BUDGET_MULT", 3);
      return value > 0 ? value : 3;
    },
    get pendingPumpMs(): number {
      return intEnv("TASK_ORCH_PENDING_PUMP_MS", 15_000);
    },
    get maxDeferMs(): number {
      return intEnv("TASK_ORCH_MAX_DEFER_MS", 30 * 60_000);
    },
  }),

  /** Agent backend + model defaults. */
  agent: Object.freeze({
    /** Deployment default backend ("pi"/"claude"/"codex") when a run has no
     *  per-run choice. Normalized/validated by resolveBackendId. */
    get backend(): string | undefined {
      return strEnv("TASK_ORCH_AGENT_BACKEND");
    },
    /** Absolute path to an external Claude Code executable for the Claude
     *  backend to drive instead of the SDK's bundled platform binary.
     *  Explicit-only — never probed from PATH. */
    get claudeBinary(): string | undefined {
      return strEnv("TASK_ORCH_CLAUDE_BINARY");
    },
    /** Absolute path to an external `codex` executable for the Codex backend to
     *  drive instead of the one @openai/codex ships. Explicit-only. */
    get codexBinary(): string | undefined {
      return strEnv("TASK_ORCH_CODEX_BINARY");
    },
    /** Sandbox policy for the Codex backend's own shell/patch tools. Defaults
     *  to `workspace-write`, which confines writes to the run's working
     *  directory at the OS level — the invariant lib/extensions/sandbox.ts
     *  enforces on the other two backends by checking tool arguments. A
     *  deployment whose runs are already isolated (the worker-container model)
     *  can widen it to `danger-full-access`. An unrecognised value falls back
     *  to the default rather than failing every codex run. */
    get codexSandbox(): "read-only" | "workspace-write" | "danger-full-access" {
      const value = strEnv("TASK_ORCH_CODEX_SANDBOX");
      return value === "read-only" || value === "danger-full-access" || value === "workspace-write"
        ? value
        : "workspace-write";
    },
    get model(): string | undefined {
      return strEnv("TASK_ORCH_AGENT_MODEL");
    },
    /** Deployment default reasoning level for runs created without one
     *  (personas carry no reasoning level any more — migration 0031). An
     *  unrecognised value is ignored rather than thrown: a typo here must not
     *  stop every run from being created. Undefined leaves the model's own
     *  default in place. */
    get thinkingLevel(): "low" | "medium" | "high" | "xhigh" | undefined {
      const value = strEnv("TASK_ORCH_THINKING_LEVEL");
      return value === "low" || value === "medium" || value === "high" || value === "xhigh"
        ? value
        : undefined;
    },
    get chatModel(): string | undefined {
      return strEnv("TASK_ORCH_CHAT_MODEL");
    },
    get titleModel(): string | undefined {
      return strEnv("TASK_ORCH_TITLE_MODEL");
    },
    get chatIdleMs(): number {
      const value = intEnv("TASK_ORCH_CHAT_IDLE_MS", 600_000);
      return value > 0 ? value : 600_000;
    },
    get chatMaxToolRounds(): number {
      const value = intEnv("TASK_ORCH_CHAT_MAX_TOOL_ROUNDS", 64);
      return value > 0 ? value : 64;
    },
    get executorMaxToolRounds(): number {
      const value = intEnv("TASK_ORCH_EXECUTOR_MAX_TOOL_ROUNDS", 30);
      return value > 0 ? value : 30;
    },
  }),

  /** Channel bridge (`npm run pipe`). The Discord-specific vars are NOT here:
   *  they are per-persona-bot secrets discovered by name at boot
   *  (lib/pipe/config.ts), not deployment-wide settings. */
  pipe: Object.freeze({
    /** Throttle for the in-place draft edits a streaming reply makes, in ms. */
    get editThrottleMs(): number {
      const value = intEnv("TASK_ORCH_PIPE_EDIT_MS", 750);
      return value > 0 ? value : 750;
    },
    /** How long a turn may run before the persona acks it with 👀. 0 disables. */
    get ackAfterMs(): number {
      const value = intEnv("TASK_ORCH_PIPE_ACK_MS", 5000);
      return value >= 0 ? value : 5000;
    },
    /**
     * Breadcrumb-relay poll interval, in ms. 0 disables the relay — AND the
     * wake pump that shares it (ChannelManager), which since M5 is the only
     * thing that drives a mapped persona conversation's milestone turn: the
     * control plane defers those wakes to this process. Zero it and threads go
     * quiet on everything but typed messages.
     */
    get relayPollMs(): number {
      const value = intEnv("TASK_ORCH_PIPE_RELAY_POLL_MS", 15_000);
      return value >= 0 ? value : 15_000;
    },
    /** Agent turns a persona conversation may accumulate before the
     *  long-thread guard resets it with a carried-over summary. 0 disables. */
    get turnCap(): number {
      const value = intEnv("TASK_ORCH_PIPE_TURN_CAP", 60);
      return value >= 0 ? value : 60;
    },
    /**
     * Port for the pipe's own Prometheus endpoint (`GET /metrics`), bound to
     * loopback. 0 (the default) disables it entirely — no listener is created.
     *
     * WHY IT EXISTS. The messaging metrics (PRD §11, lib/pipe/metrics.ts) are
     * prom-client counters in the process that emits them, and the pipe is a
     * standalone process: the web app's /api/metrics can serve the DB-derived
     * gauges but not these. Same registry, same names, second listener.
     */
    get metricsPort(): number {
      const value = intEnv("TASK_ORCH_PIPE_METRICS_PORT", 0);
      return value > 0 && value < 65_536 ? value : 0;
    },
  }),

  /** Public base URL of the web UI. Used for the deep links messaging surfaces
   *  put next to every task/plan/run id (PRD §8 "links, not dumps"). Empty when
   *  unset, in which case callers emit bare paths. */
  get publicUrl(): string {
    return strEnv("TASK_ORCH_PUBLIC_URL", "").replace(/\/+$/, "");
  },

  /** Feature gates. */
  features: Object.freeze({
    get autoLaunch(): boolean {
      return truthy(process.env.TASK_ORCH_AUTO_LAUNCH);
    },
    get ciAutofix(): boolean {
      // Default ON, matching the real gate (autofixEnabledFor in
      // github-webhook.ts): only an explicit 0/false/no/off disables it.
      // truthy() here would misreport the default deploy as disabled — and
      // silently invert the default if control flow ever migrates to this getter.
      return !/^(0|false|no|off)$/i.test((process.env.TASK_ORCH_CI_AUTOFIX ?? "").trim());
    },
    /** Keep worktrees after a run finishes (debugging). */
    get keepWorktrees(): boolean {
      return truthy(process.env.TASK_ORCH_KEEP_WORKTREES);
    },
    get worktreeGc(): boolean {
      return truthy(process.env.TASK_ORCH_WORKTREE_GC);
    },
    /**
     * How a worktree gets node_modules from the repo root: "clone" (default,
     * copy-on-write — the worktree owns a private tree) or "link" (the shared
     * symlink store). See lib/worktree-env.ts for the trade-off.
     */
    get worktreeNodeModules(): "clone" | "link" {
      const raw = (process.env.TASK_ORCH_WORKTREE_NODE_MODULES ?? "").trim().toLowerCase();
      return raw === "link" || raw === "symlink" ? "link" : "clone";
    },
    /** Archive worker logs/artifacts to R2. */
    get archiveR2(): string | undefined {
      return strEnv("TASK_ORCH_ARCHIVE_R2");
    },
  }),

  /** Sprites provider settings. See docs/runners/sprites.md */
  sprites: Object.freeze({
    get token(): string | undefined {
      return strEnv("SPRITES_TOKEN") ?? strEnv("TASK_ORCH_SPRITES_TOKEN");
    },
    get baseUrl(): string {
      return strEnv("TASK_ORCH_SPRITES_BASE_URL", "https://api.sprites.dev/v1") as string;
    },
    get prefix(): string {
      return strEnv("TASK_ORCH_SPRITE_PREFIX", "to-run-") as string;
    },
    get poolSize(): number {
      return intEnv("TASK_ORCH_SPRITE_POOL_SIZE", 0);
    },
    get maxSprites(): number {
      return intEnv("TASK_ORCH_MAX_SPRITES", 0);
    },
    get netAllow(): string | undefined {
      return strEnv("TASK_ORCH_SPRITE_NET_ALLOW");
    },
    get terminalMs(): number {
      return intEnv("TASK_ORCH_RUNNER_TERMINAL_MS", 24 * 60 * 60 * 1000);
    },
    get orphanGraceMs(): number {
      return intEnv("TASK_ORCH_SPRITES_ORPHAN_GRACE_MS", 10 * 60_000);
    },
    /** Where a sprite curls the worker bundle from. Defaults to this control
     *  plane's own /api/worker-bundle under TASK_ORCH_PUBLIC_URL. */
    get workerBundleUrl(): string | undefined {
      const explicit = strEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL");
      if (explicit) return explicit;
      const base = config.publicUrl;
      return base ? `${base}/api/worker-bundle` : undefined;
    },
  }),

  /** Storage / persistence. */
  db: Object.freeze({
    /** SQLite/pg path override (TASK_ORCH_DB); DATABASE_URL is separate. */
    get path(): string | undefined {
      return strEnv("TASK_ORCH_DB");
    },
    get pgSchema(): string | undefined {
      return strEnv("TASK_ORCH_PG_SCHEMA");
    },
    get migrationsDir(): string | undefined {
      return strEnv("TASK_ORCH_MIGRATIONS_DIR");
    },
    get targetRepo(): string | undefined {
      return strEnv("TASK_ORCH_TARGET_REPO");
    },
  }),
});

/**
 * A frozen, plain-value snapshot of the whole config for logging/telemetry.
 * Evaluates every getter ONCE at call time — do not cache it across an env
 * mutation. Not for control-flow (use the live accessors above).
 */
export function snapshot() {
  const dump = (o: object): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = (o as Record<string, unknown>)[k];
    return Object.freeze(out);
  };
  return Object.freeze({
    deployment: dump(config.deployment),
    worker: dump(config.worker),
    dispatch: dump(config.dispatch),
    agent: dump(config.agent),
    features: dump(config.features),
    sprites: dump(config.sprites),
    db: dump(config.db),
    derived: Object.freeze({
      runnerProviderKind: runnerProviderKind(),
      insideWorker: insideWorker(),
      detachedRunsEnabled: detachedRunsEnabled(),
      nestedDispatchMode: nestedDispatchMode(),
    }),
  });
}
