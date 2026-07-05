// lib/profiles.ts
//
// A profile is a string key that resolves to one or more pi extension factories.
// `toolsProfile` on a run is a comma-separated list of profile keys; the
// runner concatenates the factory lists from each.
//
// 'orchestrator' mounts the task-orchestrator surface (plans, tasks, notes,
// criteria, sessions) via the agent extension.
// 'repo_write' / 'repo_read' are markers for the SDK's built-in fs tools;
// they contribute no factories today (kept for future tightening).
// 'gh_pr', 'gh_ci' mount the GitHub PR / CI helper extensions.
// 'gh_pr_ro' mounts the read-only subset of gh_pr (view/diff/comment/review
// without approve — no pr_merge). Used for review runs, which check out an
// untrusted third-party PR and must not be able to merge or approve it.
// 'spawn' mounts the child-spawn extension.

import type { ExtensionFactory } from "./extensions/types";
import type { RunRow } from "./runs";

export interface ProfileContext {
  runId: number;
  run: RunRow;
  author: string;
  taskId: string | null;
  planId: string | null;
  cwd: string;
}

interface ProfileDef {
  factories: (ctx: ProfileContext) => Array<ExtensionFactory> | Promise<Array<ExtensionFactory>>;
  allowsRepoWrite?: boolean;
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
      })];
    },
  },
  repo_write: { factories: () => [], allowsRepoWrite: true },
  repo_read:  { factories: () => [], allowsRepoWrite: false },
  gh_pr: {
    factories: async (ctx) => {
      const { ghPrExtension } = await import("./extensions/gh-pr");
      return [ghPrExtension({ cwd: ctx.cwd, runId: ctx.runId })];
    },
  },
  gh_pr_ro: {
    factories: async (ctx) => {
      const { ghPrReadOnlyExtension } = await import("./extensions/gh-pr");
      return [ghPrReadOnlyExtension({ cwd: ctx.cwd, runId: ctx.runId })];
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
      return [spawnExtension({ runId: ctx.runId, runRow: ctx.run })];
    },
  },
  planning: {
    factories: async (ctx) => {
      const { planningExtension } = await import("./extensions/planning");
      return [planningExtension({ runId: ctx.runId, run: ctx.run })];
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
  return [eventsExtension({ runId: ctx.runId, runRow: ctx.run })];
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
