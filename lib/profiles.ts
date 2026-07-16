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
  },
  repo_write: {
    factories: async (ctx) => {
      const { repoReadExtension } = await import("./extensions/repo-read");
      return [repoReadExtension({ cwd: ctx.cwd })];
    },
    allowsRepoWrite: true,
  },
  repo_read:  {
    factories: async (ctx) => {
      const { repoReadExtension } = await import("./extensions/repo-read");
      return [repoReadExtension({ cwd: ctx.cwd })];
    },
    allowsRepoWrite: false,
  },
  gh_pr: {
    factories: async (ctx) => {
      const { ghPrExtension } = await import("./extensions/gh-pr");
      const remote = await resolveRemote(ctx);
      return [ghPrExtension({ cwd: ctx.cwd, remote, runId: ctx.runId })];
    },
  },
  gh_pr_ro: {
    factories: async (ctx) => {
      const { ghPrReadOnlyExtension } = await import("./extensions/gh-pr");
      const remote = await resolveRemote(ctx);
      return [ghPrReadOnlyExtension({ cwd: ctx.cwd, remote, runId: ctx.runId })];
    },
  },
  gh_ci: {
    factories: async (ctx) => {
      const { ghCiExtension } = await import("./extensions/gh-ci");
      return [ghCiExtension({ cwd: ctx.cwd })];
    },
  },
  spawn: {
    factories: async (ctx) => {
      const { spawnExtension } = await import("./extensions/spawn");
      return [spawnExtension({ runId: ctx.runId, invoke: ctx.invoke })];
    },
  },
  planning: {
    factories: async (ctx) => {
      const { planningExtension } = await import("./extensions/planning");
      return [planningExtension({ runId: ctx.runId, run: ctx.run, invoke: ctx.invoke })];
    },
  },
};

/** Static list of known profile keys for UI pickers and validation. */
export function listProfiles(): string[] {
  return Object.keys(PROFILES);
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
