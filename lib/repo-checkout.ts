// lib/repo-checkout.ts
//
// Repository checkout inside a runner, with NO database access. Shared by the
// in-process driver (lib/runs.ts containerCheckoutAt) and the ws worker
// (lib/worker-runtime/cwd.ts), which only holds the run.start snapshot.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { config } from "./config";
import { ownerRepoFromRemote } from "./gh-url";
import { timeRunnerPhase } from "./runner/telemetry";

export function sh(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(args[0], args.slice(1), { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code === 0) resolveP(stdout);
      else rejectP(new Error(`${args.join(" ")} exited ${code}\n${stderr || stdout}`));
    });
  });
}

export async function hasUsableGitCheckout(work: string): Promise<boolean> {
  if (!existsSync(join(work, ".git"))) return false;
  try {
    const out = await sh(["git", "-C", work, "rev-parse", "--is-inside-work-tree"], "/");
    return out.trim() === "true";
  } catch {
    return false;
  }
}

// Shallow-clone flags for the in-runner checkout, from TASK_ORCH_GIT_CLONE_DEPTH
// (default 1). `--no-single-branch` still fetches every branch tip so the later
// origin/<base> fallback checkout can resolve. A depth of 0 disables shallowing.
export function gitCloneDepthArgs(): string[] {
  const depth = config.deployment.gitCloneDepth;
  return depth > 0 ? ["--depth", String(depth), "--no-single-branch"] : [];
}

/** The URL `git clone` gets for a repository remote: GitHub owner/repo become
 *  the https URL (auth via the credential helper); a local path or file:// /
 *  ssh URL is used as-is (tests, self-hosted). */
export function cloneUrlFromRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const parsed = ownerRepoFromRemote(remote);
  if (parsed) return `https://github.com/${parsed.owner}/${parsed.repo}`;
  if (remote.startsWith("file://") || isAbsolute(remote) || /^(ssh|git|https?):\/\//.test(remote) || /^[\w.-]+@[\w.-]+:/.test(remote)) {
    return remote;
  }
  return null;
}

/** A runner that has no git credential helper (a sprite) authenticates GitHub
 *  over https with GH_TOKEN. Idempotent; a no-op when a helper is already
 *  configured or there is no token. */
export async function ensureGitCredentialHelper(): Promise<void> {
  if (!process.env.GH_TOKEN) return;
  const existing = await sh(["git", "config", "--global", "--get", "credential.helper"], "/").catch(() => "");
  if (existing.trim()) return;
  // Reads GH_TOKEN at use time — no token lands in any config file.
  const helper = '!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f';
  await sh(["git", "config", "--global", "credential.helper", helper], "/").catch(() => {});
}

export interface CheckoutRepositoryOptions {
  runId: number;
  repoId: string | null;
  /** The repository's remote (GitHub URL/slug, or a clonable URL/path). */
  remote: string | null | undefined;
  /** Directory the checkout lives in. Created (or re-cloned) as needed. */
  work: string;
  /** Branch to end on. */
  branch: string;
  /** Branch to fork from when origin/<branch> does not exist yet. */
  base: string;
  /** Optional bare mirror used as `--reference`. */
  mirrorDir?: string | null;
  /** A path that promises an existing checkout and must never be re-cloned. */
  configuredPath?: string | null;
  /** Telemetry label. */
  provider?: "local" | "sprites" | "unknown";
}

/**
 * Ensure `work` holds a checkout of the repository on `branch`.
 * Idempotent: an existing clone is fetched and switched in place; otherwise the
 * repository is cloned (blobless, optionally shallow). Existing-branch first:
 * a branch another run already pushed is checked out from origin/<branch>;
 * only when it does not exist yet is it created off origin/<base>.
 */
export async function checkoutRepositoryAt(opts: CheckoutRepositoryOptions): Promise<string> {
  const { runId, repoId, work, branch, base } = opts;
  const provider = opts.provider ?? "unknown";
  const url = cloneUrlFromRemote(opts.remote);
  if (!url) {
    throw new Error(
      `Run #${runId}: repository '${repoId ?? "(default)"}' has no clonable remote for the worker.`
    );
  }
  if (url.startsWith("https://github.com/")) {
    if (!process.env.GH_TOKEN) {
      throw new Error(`Run #${runId}: GH_TOKEN is required for in-runner checkout.`);
    }
    await ensureGitCredentialHelper();
  }
  await mkdir(dirname(work), { recursive: true });
  if (!(await hasUsableGitCheckout(work))) {
    if (opts.configuredPath && resolve(opts.configuredPath) === resolve(work)) {
      throw new Error(
        `Run #${runId}: configured runner repository '${work}' is missing or is not a valid Git checkout. ` +
          "Repair TASK_ORCH_RUNNER_REPO_PATH."
      );
    }
    if (existsSync(work)) await rm(work, { recursive: true, force: true });
    const mirror = opts.mirrorDir ?? null;
    const reference = mirror && existsSync(mirror) ? ["--reference", mirror, "--dissociate"] : [];
    const depth = gitCloneDepthArgs();
    await timeRunnerPhase(
      "git_clone",
      () => sh(["git", "clone", "--filter=blob:none", ...depth, ...reference, url, work], "/"),
      { provider, fields: { runId, repoId, reference: reference.length > 0, shallow: depth.length > 0 } }
    );
  } else {
    await sh(["git", "-C", work, "remote", "set-url", "origin", url], "/").catch(() => {});
  }
  await timeRunnerPhase(
    "git_fetch",
    () => sh(["git", "-C", work, "fetch", "--prune", "origin"], "/").catch(() => {}),
    { provider, fields: { runId, repoId } }
  );
  try {
    await timeRunnerPhase(
      "git_fetch_branch",
      () => sh(["git", "-C", work, "fetch", "origin", branch], "/"),
      { provider, fields: { runId, branch } }
    );
    await timeRunnerPhase(
      "git_checkout",
      () => sh(["git", "-C", work, "checkout", "-B", branch, `origin/${branch}`], "/"),
      { provider, fields: { runId, branch } }
    );
  } catch {
    await timeRunnerPhase(
      "git_checkout",
      () => sh(["git", "-C", work, "checkout", "-B", branch, `origin/${base}`], "/"),
      { provider, fields: { runId, branch, base, fallback: true } }
    );
  }
  return work;
}
