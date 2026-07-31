// lib/profiles.ts
//
// A profile is a string key that resolves to one or more pi extension factories.
// `toolsProfile` on a run is a comma-separated list of profile keys; the
// runner concatenates the factory lists from each.
//
// 'orchestrator' mounts the task-orchestrator surface (plans, tasks, notes,
// criteria, sessions) via the agent extension.
// 'repo_write' / 'repo_read' mount narrow read-only repo helper tools; full
// backend runs also have their SDK built-in fs tools.
// 'gh_pr', 'gh_ci' mount the GitHub PR / CI helper extensions.
// 'gh_pr_ro' mounts the read-only subset of gh_pr (view/diff/comment/review
// without approve — no pr_merge). Used for review runs, which check out an
// untrusted third-party PR and must not be able to merge or approve it.
// 'spawn' mounts the child-spawn extension.
// Brave Search is always-on for chat/agent runs rather than a profile entry:
// web lookup is broadly useful, read-only, and the tool itself fails closed
// when BRAVE_SEARCH_API_KEY is not configured.

import type { ExtensionFactory, ToolInvoker } from "./extensions/types";
import type { RunRow } from "./runs";

export interface ProfileContext {
  runId: number;
  run: RunRow;
  author: string;
  taskId: string | null;
  planId: string | null;
  cwd: string;
  /** Tool execution seam (plan section 15). The ws worker path supplies the
   *  channel invoker (session.invokeTool); absent → extensions fall back to
   *  the legacy transport-backed invoker (control-plane/in-process runs). */
  invoke?: ToolInvoker;
  /** Pre-resolved repository remote for gh_pr profiles. The ws worker cannot
   *  call runTransport().resolveRepo — the control plane pushed the resolved
   *  repository in `run.start`, so the driver passes its remote here.
   *  undefined → resolve via the legacy transport (in-process path). */
  repoRemote?: string | null;
}

interface ProfileDef {
  factories: (ctx: ProfileContext) => Array<ExtensionFactory> | Promise<Array<ExtensionFactory>>;
  allowsRepoWrite?: boolean;
  /**
   * May this profile be mounted by a `runtime: 'server'` run?
   *
   * A server-runtime run (persona chats — see docs/superpowers/specs/
   * 2026-07-31-discord-personas-messaging-design.md §3/§6) executes IN the
   * server/pipe process: same uid, same filesystem, `DATABASE_URL` and every
   * agent credential in reach, no container and no worktree to contain it.
   * The only thing standing between a prompt-injected persona and the host is
   * the tool surface it was handed — so server runtime is restricted to
   * profiles whose every tool is *tool-mediated* (Postgres rows or a remote
   * API), with no shell, no filesystem, and no repo write.
   *
   * Classification (grounded in what each factory actually mounts, not in the
   * profile's name):
   *   orchestrator  SAFE   — lib/extensions/agent.ts: ORCHESTRATOR_TOOLS,
   *                          plans/tasks/criteria/notes/sessions CRUD over the
   *                          DB. No process, no fs.
   *   planning      SAFE   — lib/extensions/planning.ts: reads/writes plan rows
   *                          and agent_messages. No process, no fs.
   *   spawn         SAFE   — lib/extensions/spawn.ts: creates CHILD runs, which
   *                          are worker-runtime (containerized) by default. The
   *                          shell the persona wants lives in the child's
   *                          container, which is exactly the intended split.
   *   gh_pr_ro      SAFE   — lib/extensions/gh-pr.ts read-only subset, Octokit
   *                          only (view/diff/comments/checks); no approve, no
   *                          merge, no local git, no fs.
   *   gh_ci         SAFE   — lib/extensions/gh-ci.ts, Octokit only (runs/logs/
   *                          rerun). ci_rerun re-triggers an existing workflow;
   *                          it cannot introduce code or touch the host.
   *   gh_pr         UNSAFE — same module, but the full set includes
   *                          gh_pr__pr_merge and gh_pr__pr_review (approve).
   *                          Merging is a repo write performed with the
   *                          server's own GitHub credentials — a persona could
   *                          land arbitrary code on a default branch without a
   *                          human ever seeing it.
   *   repo_read     UNSAFE — despite the name it is NOT tool-mediated: it
   *                          mounts lib/extensions/repo-read.ts, which spawns
   *                          `git` child processes and does readFile/readdir
   *                          under ctx.cwd. On a server-runtime run cwdStrategy
   *                          is 'none', so that cwd is the ORCHESTRATOR's own
   *                          checkout — i.e. arbitrary reads of the server's
   *                          working tree (and process spawning) from a chat
   *                          message. Reading is exactly the exfiltration half
   *                          of the threat model §6 closes.
   *   repo_write    UNSAFE — repo_read's surface plus allowsRepoWrite, which
   *                          unlocks the backend's built-in fs/bash tools.
   *
   * Anything added later defaults to UNSAFE (the flag is opt-in): a new profile
   * has to be read and classified before a persona chat can mount it.
   */
  serverSafe?: boolean;
}

/** gh_pr remote: pre-resolved by the ws worker (from the run.start snapshot),
 *  otherwise looked up via the legacy transport (in-process/control plane). */
async function resolveRemote(ctx: ProfileContext): Promise<string | null> {
  if (ctx.repoRemote !== undefined) return ctx.repoRemote;
  const { runTransport } = await import("@/lib/worker");
  const repo = await (await runTransport()).resolveRepo(ctx.runId);
  return repo?.remote ?? null;
}

const PROFILES: Record<string, ProfileDef> = {
  orchestrator: {
    factories: async (ctx) => {
      const { orchestratorExtension } = await import("./extensions/agent");
      return [orchestratorExtension({
        author: ctx.author,
        defaultTaskId: ctx.taskId ?? undefined,
        defaultPlanId: ctx.planId ?? undefined,
        runId: ctx.runId,
        invoke: ctx.invoke,
      })];
    },
    serverSafe: true,
  },
  repo_write: {
    factories: async (ctx) => {
      const { repoReadExtension } = await import("./extensions/repo-read");
      return [repoReadExtension({ cwd: ctx.cwd })];
    },
    allowsRepoWrite: true,
    serverSafe: false,
  },
  repo_read:  {
    factories: async (ctx) => {
      const { repoReadExtension } = await import("./extensions/repo-read");
      return [repoReadExtension({ cwd: ctx.cwd })];
    },
    allowsRepoWrite: false,
    serverSafe: false,
  },
  gh_pr: {
    factories: async (ctx) => {
      const { ghPrExtension } = await import("./extensions/gh-pr");
      const remote = await resolveRemote(ctx);
      return [ghPrExtension({ cwd: ctx.cwd, remote, runId: ctx.runId })];
    },
    serverSafe: false,
  },
  gh_pr_ro: {
    factories: async (ctx) => {
      const { ghPrReadOnlyExtension } = await import("./extensions/gh-pr");
      const remote = await resolveRemote(ctx);
      return [ghPrReadOnlyExtension({ cwd: ctx.cwd, remote, runId: ctx.runId })];
    },
    serverSafe: true,
  },
  gh_ci: {
    factories: async (ctx) => {
      const { ghCiExtension } = await import("./extensions/gh-ci");
      return [ghCiExtension({ cwd: ctx.cwd })];
    },
    serverSafe: true,
  },
  spawn: {
    factories: async (ctx) => {
      const { spawnExtension } = await import("./extensions/spawn");
      return [spawnExtension({ runId: ctx.runId, invoke: ctx.invoke })];
    },
    serverSafe: true,
  },
  planning: {
    factories: async (ctx) => {
      const { planningExtension } = await import("./extensions/planning");
      return [planningExtension({ runId: ctx.runId, run: ctx.run, invoke: ctx.invoke })];
    },
    serverSafe: true,
  },
};

/** Static list of known profile keys for UI pickers and validation. */
export function listProfiles(): string[] {
  return Object.keys(PROFILES);
}

/** Profile keys a `runtime: 'server'` run may mount (see ProfileDef.serverSafe). */
export function listServerSafeProfiles(): string[] {
  return Object.keys(PROFILES).filter((k) => PROFILES[k].serverSafe === true);
}

/**
 * The profile keys in `profileString` that a server-runtime run must NOT mount:
 * anything shell-capable, filesystem-capable, or repo-writing (see
 * ProfileDef.serverSafe), plus any key that isn't a known profile at all —
 * an unknown key can't be vouched for, and resolveProfiles would throw later
 * anyway. Empty array ⇒ the profile string is safe for server runtime.
 *
 * Split out from resolveProfiles deliberately: the guardrail must run at
 * runs.create() time, where there is no cwd/run row to build a ProfileContext
 * from — and a rejection at create time is worth far more than one at turn
 * time (no ghost row, and the caller learns immediately).
 */
export function serverUnsafeProfiles(profileString: string): string[] {
  return profileString
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((name) => PROFILES[name]?.serverSafe !== true);
}

/**
 * Extensions mounted for EVERY run regardless of tools_profile
 * (docs/agent-events.md §7: "every agent, in every tools profile, can always
 * go to sleep"). Deliberately NOT a PROFILES entry — timer__*, events__*,
 * report_result, raise, ask_parent, answer_question must not be strandable
 * by a profile-string typo the way a missing 'spawn' entry can strand
 * spawn__*. The runner (lib/runs.ts) calls this unconditionally and appends
 * the result to whatever resolveProfiles() returns.
 */
export async function alwaysOnExtensions(ctx: ProfileContext): Promise<ExtensionFactory[]> {
  const { eventsExtension } = await import("./extensions/events");
  const { braveSearchExtension } = await import("./extensions/brave-search");
  return [
    eventsExtension({ runId: ctx.runId, invoke: ctx.invoke }),
    braveSearchExtension(),
  ];
}

export interface ResolvedProfile {
  factories: ExtensionFactory[];
  allowsRepoWrite: boolean;
}

export async function resolveProfiles(
  profileString: string,
  ctx: ProfileContext,
): Promise<ResolvedProfile> {
  const names = profileString
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const factories: ExtensionFactory[] = [];
  let allowsRepoWrite = false;
  for (const name of names) {
    const def = PROFILES[name];
    if (!def) throw new Error(`Unknown tools profile: ${name}`);
    const got = await def.factories(ctx);
    factories.push(...got);
    if (def.allowsRepoWrite) allowsRepoWrite = true;
  }
  return { factories, allowsRepoWrite };
}
