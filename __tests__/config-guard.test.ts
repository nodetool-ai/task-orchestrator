// __tests__/config-guard.test.ts
//
// R6 lint guard: TASK_ORCH_* env vars are read through lib/config, not ad hoc.
// New code must not reach for process.env.TASK_ORCH_ directly — it belongs in
// lib/config with a documented one-liner. The ALLOWLIST below is the migration
// debt: files that still read the env directly (env passthrough/forwarding, or
// long-tail single-use tunables not yet migrated). It may only SHRINK — adding a
// file here should be a deliberate, reviewed decision, and removing entries as
// they migrate is the goal.
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Files permitted to read process.env.TASK_ORCH_* directly today (git-relative,
// forward slashes). Reasons:
//  - lib/config.ts        the ONE reader (this is the point).
//  - lib/run-dispatch.ts  forwards TASK_ORCH_* into worker containers by name
//                         (pass()/workerDispatchEnv) — serialization, not a read.
//  - lib/runs.ts          long-tail tunables (chat idle, budgets) not yet migrated.
//  - lib/runner/fly*.ts   fly machine sizing/region long-tail.
//  - lib/runner/worker-sha.ts  reads TASK_ORCH_WORKER_SHA at build-SHA
//                         resolution time (a bootstrap concern with its own
//                         40-char validation), deliberately before/without
//                         lib/config.
//  - the rest             single-use reads in feature modules + scripts/.
// (lib/runner/lifecycle.ts reads its RUNNER_*_MS windows via a dynamic
//  process.env[key] helper, so the literal-pattern guard never flags it.)
const CONFIG_FILE = "lib/config.ts";
const ALLOWLIST = new Set([
  CONFIG_FILE,
  "lib/agent.ts",
  "lib/auto-launch.ts",
  "lib/chat-title.ts",
  "lib/chat.ts",
  "lib/ci-autofix.ts",
  "lib/extensions/spawn.ts",
  "lib/run-dispatch.ts",
  "lib/runner/fly-client.ts",
  "lib/runner/fly.ts",
  "lib/runner/sprites-client.ts",
  "lib/runner/worker-sha.ts",
  "lib/runs.ts",
  "lib/worker/log.ts",
  "lib/worktree-gc.ts",
  "scripts/reset.ts",
  "scripts/seed-prewarm-volume.ts",
  "scripts/seed.ts",
  // Dev CLI harness (npm run chat): reads a few TASK_ORCH_* tunables to launch
  // a worker/chat locally. A script, not runtime code — same category as the
  // other scripts/*.ts entries above.
  "scripts/worker-chat.ts",
  // Ops probe (see its header): provisions one disposable Fly Machine and dials
  // its worker channel. Reads TASK_ORCH_FLY_APP/REGION and its own
  // TASK_ORCH_FLY_PROBE opt-in gate. A script, not runtime code — same category
  // as the other scripts/*.ts entries above.
  "scripts/fly-channel-probe.ts",
  // Sprites feasibility spike (see its header): provisions one disposable
  // sprite from a bare token + base URL, before any control plane exists. A
  // script, not runtime code — same category as the other scripts/*.ts entries.
  "scripts/sprites-feasibility.ts",
]);

// git grep emits forward-slash paths on every platform, so no normalization.
function filesReadingEnv(): string[] {
  let out = "";
  try {
    out = execSync(
      'git grep -lE "process\\.env(\\.TASK_ORCH_|\\[[^]]*TASK_ORCH_)" -- lib db scripts',
      { cwd: ROOT, encoding: "utf8" }
    );
  } catch (e: unknown) {
    // git grep exits 1 when there are no matches — treat as empty.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".ts"));
}

describe("process.env.TASK_ORCH_ guard (R6)", () => {
  it("no file outside the allowlist reads TASK_ORCH_* directly", () => {
    const offenders = filesReadingEnv().filter((f) => !ALLOWLIST.has(f));
    expect(
      offenders,
      `Read TASK_ORCH_* via lib/config instead, or add to the allowlist with a reason:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the allowlist only shrinks — every entry (bar config) still reads the env", () => {
    const reading = new Set(filesReadingEnv());
    const stale = [...ALLOWLIST].filter((f) => f !== CONFIG_FILE && !reading.has(f));
    expect(
      stale,
      `These allowlisted files no longer read TASK_ORCH_* — drop them from the allowlist:\n${stale.join("\n")}`
    ).toEqual([]);
  });
});
