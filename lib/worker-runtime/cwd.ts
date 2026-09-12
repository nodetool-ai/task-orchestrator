// lib/worker-runtime/cwd.ts
//
// The ws worker's working directory. A remote worker (sprite, container) has
// none of the control plane's paths, so the repository must be cloned INSIDE
// the runner from the run.start snapshot — the channel-native counterpart of
// lib/runs.ts prepareCwd()/ensureWorktreeBranch(), without any DB access.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { config, insideWorker } from "../config";
import { checkoutRepositoryAt } from "../repo-checkout";
import { validateCwd } from "../run-cwd";
import { prepareSpriteDependencies } from "./dependencies";
import type { RunStart } from "../worker-channel/protocol";

export interface PreparedCwd {
  cwd: string;
  /** Set when the worker created/selected the checkout itself; reported back
   *  to the control plane on the next run.checkpoint. */
  branch?: string;
  worktreePath?: string;
}

function field<T>(obj: unknown, key: string): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return v == null ? undefined : (v as T);
}

/** Where a managed runner keeps its checkout: the configured runner repo path,
 *  else `$SESSION_ROOT/repo` (sprites, Fly), else `/work/<run>` when a repo
 *  cache marks a worker container. `null` means "not a managed runner" (a
 *  local dev worker that shares the control plane's filesystem). */
export function runnerCheckoutDir(runId: number): string | null {
  const configured = config.worker.runnerRepoPath;
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("TASK_ORCH_RUNNER_REPO_PATH must be an absolute path inside the runner.");
    return resolve(configured);
  }
  const root = process.env.SESSION_ROOT;
  if (root) return join(root, "repo");
  if (process.env.REPO_CACHE_DIR) return `/work/${runId}`;
  return null;
}

/** Branch a worker checks out for a run, mirroring ensureWorktreeBranch():
 *  the run's recorded branch, else the task's canonical branch, else a
 *  per-run chat branch. Ordinary repo strategies use the default branch;
 *  reusable Sprite checkouts always use a private run branch. */
export function workerBranchFor(start: RunStart, defaultBranch: string): string {
  const run = start.run;
  const strategy = field<string>(run, "cwdStrategy") ?? "worktree";
  const reusableSpriteCheckout = process.env.TASK_ORCH_SPRITE_RUN_WORKTREE === "1";
  const recorded = field<string>(run, "branch");
  if (recorded) return recorded;
  if (!reusableSpriteCheckout && strategy !== "worktree" && strategy !== "worktree_at_pr") return defaultBranch;
  const taskBranch = field<string>(start.task, "branch");
  if (taskBranch) return taskBranch;
  const taskId = field<string>(start.task, "id") ?? field<string>(run, "taskId");
  if (taskId) return `claude/${taskId.toLowerCase()}`;
  return `claude/chat-${run.id}`;
}

/**
 * Resolve (and if needed materialize) the turn cwd for a ws worker.
 *
 * Order: an existing recorded worktree → the control plane's local path when
 * this worker shares its filesystem (local provider) → a clone of the
 * repository's remote into the runner's checkout dir (managed runners).
 */
export async function prepareWorkerCwd(start: RunStart): Promise<PreparedCwd> {
  const run = start.run;
  const runId = run.id;
  const repoId = field<string>(start.repository, "id") ?? null;
  const recordedWorktree = field<string>(run, "worktreePath");
  const localPath = field<string>(start.repository, "localPath");
  const remote = field<string>(start.repository, "remote") ?? null;
  const defaultBranch = field<string>(start.repository, "defaultBranch") ?? "main";
  // This is selected and persisted when the run is created. It must travel in
  // the run.start snapshot: a worker cannot safely infer it from a control-plane
  // repository default that may have changed before recovery or follow-up.
  const baseBranch = field<string>(run, "baseBranch")?.trim() || defaultBranch;
  const hint =
    "This path came from the control-plane snapshot; on a remote worker the " +
    "repository needs a checkout that exists inside the runner (a clonable " +
    "remote). See docs/agent-caveats.md.";

  if (recordedWorktree && existsSync(recordedWorktree)) {
    await prepareSpriteDependencies(recordedWorktree);
    return { cwd: validateCwd(recordedWorktree, { runId, repoId, hint }) };
  }

  const work = runnerCheckoutDir(runId);
  if (!work) {
    // Not a managed runner: this worker shares the control plane's disk.
    return { cwd: validateCwd(recordedWorktree ?? localPath ?? process.cwd(), { runId, repoId, hint }) };
  }

  const branch = workerBranchFor(start, defaultBranch);
  const cwd = await checkoutRepositoryAt({
    runId,
    repoId,
    remote,
    work,
    branch,
    base: baseBranch,
    mirrorDir: process.env.REPO_CACHE_DIR ? undefined : null,
    configuredPath: config.worker.runnerRepoPath ?? null,
    provider: insideWorker() ? "sprites" : "local",
  });
  // A dependency baseline is explicitly enabled by the Sprite pool manager.
  // It runs after checkout so the requested revision is authoritative.
  await prepareSpriteDependencies(cwd);
  const strategy = field<string>(run, "cwdStrategy") ?? "worktree";
  const reports = process.env.TASK_ORCH_SPRITE_RUN_WORKTREE === "1"
    || strategy === "worktree" || strategy === "worktree_at_pr";
  return {
    cwd: validateCwd(cwd, { runId, repoId, hint }),
    ...(reports ? { branch, worktreePath: cwd } : {}),
  };
}
