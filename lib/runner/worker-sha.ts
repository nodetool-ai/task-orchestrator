// The worker build SHA that identifies which worker code a Box template must
// contain. Env override first (deployed control planes can be git-less), else
// `git rev-parse HEAD` in the server checkout, cached per process.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  try {
    const { stdout } = await (opts.exec ?? defaultExec)("git", ["rev-parse", "HEAD"]);
    const sha = stdout.trim();
    if (!SHA.test(sha)) throw new Error(`git rev-parse returned "${sha}"`);
    cached = sha;
    return sha;
  } catch (error) {
    throw new Error(
      `Cannot determine the worker build SHA (git failed: ${error instanceof Error ? error.message : String(error)}). ` +
        "Set TASK_ORCH_WORKER_SHA on git-less deployments."
    );
  }
}
