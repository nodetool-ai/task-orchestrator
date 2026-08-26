// The worker build SHA that identifies which worker code an execution
// artifact must contain. Artifacts are keyed by the tip of the pushed worker
// repo ref, so the SHA must exist on the remote — the control plane's local
// HEAD (which may be an unpushed dev commit) is NOT usable. Resolution order:
//   1. TASK_ORCH_WORKER_SHA override (deployed control planes can be git-less).
//   2. `git ls-remote <workerRepoUrl> <workerRepoRef>` — the tip of the pushed
//      ref the build clones from. Always buildable by construction.
// Cached per process.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
const defaultExec: Exec = (cmd, args) => execFileAsync(cmd, args);

let cached: string | undefined;

export function resetWorkerShaCache(): void {
  cached = undefined;
}

export async function workerBuildSha(opts: { exec?: Exec } = {}): Promise<string> {
  const override = process.env.TASK_ORCH_WORKER_SHA?.trim();
  if (override) {
    if (!SHA.test(override)) {
      throw new Error("TASK_ORCH_WORKER_SHA must be a 40-character lowercase git SHA.");
    }
    return override;
  }
  if (cached) return cached;

  const url = config.worker.repoUrl;
  const ref = config.worker.repoRef;
  try {
    // ls-remote prints "<sha>\t<ref>" for each matching ref; the tip of the
    // requested ref is the first line's SHA.
    const { stdout } = await (opts.exec ?? defaultExec)("git", ["ls-remote", url, ref]);
    const sha = stdout.trim().split(/\s+/)[0] ?? "";
    if (!SHA.test(sha)) {
      throw new Error(`ref "${ref}" not found on ${url} (ls-remote returned "${stdout.trim().slice(0, 200)}")`);
    }
    cached = sha;
    return sha;
  } catch (error) {
    throw new Error(
      `Cannot resolve the worker build SHA from ${url} ${ref} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "Push the worker ref, set TASK_ORCH_WORKER_REPO_REF, or pin TASK_ORCH_WORKER_SHA."
    );
  }
}

/**
 * SHA that identifies exactly what a host Docker build ships. Unlike
 * {@link workerBuildSha} (the tip of the pushed REMOTE worker ref), the docker
 * builder tars `process.cwd()`, so its artifact's identity is the LOCAL commit
 * the context is checked out at — not the remote ref, which can differ. Using
 * the remote ref would let the registry claim an image contains SHA X while it
 * holds unrelated source, and reject legitimate rebuilds as already ready.
 *
 * Resolution: TASK_ORCH_WORKER_SHA override first (a git-less deploy that pins
 * its identity), else `git rev-parse HEAD` of the build context. Throws with an
 * actionable message when neither is available — an unidentifiable image must
 * not be recorded as a ready artifact.
 */
export async function dockerContextSha(
  opts: { exec?: Exec; cwd?: string } = {}
): Promise<string> {
  const override = process.env.TASK_ORCH_WORKER_SHA?.trim();
  if (override) {
    if (!SHA.test(override)) {
      throw new Error("TASK_ORCH_WORKER_SHA must be a 40-character lowercase git SHA.");
    }
    return override;
  }
  const cwd = opts.cwd ?? process.cwd();
  try {
    const { stdout } = await (opts.exec ?? defaultExec)("git", ["-C", cwd, "rev-parse", "HEAD"]);
    const sha = stdout.trim();
    if (!SHA.test(sha)) {
      throw new Error(`git rev-parse HEAD returned "${sha.slice(0, 80)}"`);
    }
    return sha;
  } catch (error) {
    throw new Error(
      `Cannot identify the Docker build context SHA in ${cwd} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "Run the build from a git checkout, or pin TASK_ORCH_WORKER_SHA."
    );
  }
}
