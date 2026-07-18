// lib/run-cwd.ts
//
// Shared working-directory guard for anything that hands a cwd to an agent
// backend. A missing cwd makes `child_process.spawn` emit `ENOENT` *against
// the executable*, which the Claude Agent SDK then misreports as a
// native-binary / libc mismatch ("binary exists but failed to launch") — see
// docs/agent-caveats.md. Both the control-plane turn path (lib/runs.ts) and
// the ws worker driver (lib/worker-runtime/context.ts) validate through here
// so the failure names the offending repo/path instead.

import { existsSync, statSync } from "node:fs";

export function validateCwd(
  dir: string,
  ctx: { runId: number; repoId: string | null; hint?: string }
): string {
  const where = `repository '${ctx.repoId ?? "(default)"}'`;
  const hint = ctx.hint ? ` ${ctx.hint}` : "";
  if (!existsSync(dir)) {
    throw new Error(
      `Run #${ctx.runId}: working directory '${dir}' does not exist. ` +
        `Check the local_path of ${where}.${hint}`
    );
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(
      `Run #${ctx.runId}: working directory '${dir}' is not a directory. ` +
        `Check the local_path of ${where}.${hint}`
    );
  }
  return dir;
}
