# Standalone Worker Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the Box template build from ~11 minutes to under 4 by driving the Box's preinstalled `claude` binary via `pathToClaudeCodeExecutable` and shipping the worker as a single dependency-free JS bundle.

**Architecture:** Three independently-landable phases from `docs/superpowers/specs/2026-07-18-standalone-worker-bundle-design.md`: (1) an explicit `TASK_ORCH_CLAUDE_BINARY` config knob wired into the Claude backend, (2) a `build:worker:standalone` esbuild target with a CI isolation test, (3) the Box template build reshaped to install with `--omit=optional`, bake only the bundle, and drop the agent-repo `npm ci`. Phase 4 of the spec (agent deps on demand — prompt changes) is **not in this plan**; it is gated on a real-Box `npm install` timing measurement.

**Tech Stack:** TypeScript, esbuild, vitest, Claude Agent SDK, ascii.dev Box SDK.

## Global Constraints

- Explicit configuration only for the external claude binary: env var `TASK_ORCH_CLAUDE_BINARY`; **no PATH auto-detection** (spec §1).
- The Box's preinstalled binary path is exactly `/usr/local/bin/claude` (spec §1/§4).
- Standalone bundle build: `esbuild scripts/run-worker.ts --bundle --platform=node --format=esm --alias:@=. --external:dockerode` + `createRequire` banner → `dist/run-worker.standalone.js` (spec §2).
- The `createRequire` banner is **load-bearing** and must carry a comment saying so (spec §2).
- Isolation contract: the bundle copied alone into an empty directory and run with no args must exit **2** with the `run-worker` usage message (spec §2).
- Baked bundle path inside a Box template: `/home/user/worker/run-worker.js`; the bootstrap must still fall back to the legacy `/home/user/task-orchestrator/dist/run-worker.js` so pre-reshape templates keep working (spec §4).
- `lib/runner/box-template-builder.ts` and `scripts/install-box-template.sh` must stay mirrored (existing repo invariant).
- TDD throughout: failing test first, minimal code, all suites green before each commit.
- Test runner: `npx vitest run <file>` (repo vitest config; DB-backed tests need the local Postgres the existing suite already uses).
- Known pre-existing flakes, NOT regressions (verified via stash-compare on 2026-07-18): `worker-websocket-e2e.test.ts` "wakes on a follow-up input", `placement-routing.test.ts` "resumeServerRun duplicate-wake short-circuit".

---

### Task 1: Claude binary resolution (`resolveClaudeBinary`)

**Files:**
- Create: `lib/agent-backend/claude-binary.ts`
- Modify: `lib/config.ts` (the `agent:` block, around line 317)
- Test: `__tests__/agent-backend/claude-binary.test.ts`

**Interfaces:**
- Consumes: `config.agent.claudeBinary` (new getter added here).
- Produces: `resolveClaudeBinary(): string | undefined` — returns the validated absolute path when `TASK_ORCH_CLAUDE_BINARY` is set, `undefined` when unset, throws an actionable Error naming the path and the env var when set-but-broken. Task 2 imports it.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/agent-backend/claude-binary.test.ts`:

```ts
// __tests__/agent-backend/claude-binary.test.ts
//
// TASK_ORCH_CLAUDE_BINARY is explicit-only (no PATH probing) and must fail
// loud at resolution time — never as the SDK's opaque spawn error mid-run.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveClaudeBinary } from "../../lib/agent-backend/claude-binary";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-bin-"));
  savedEnv = process.env.TASK_ORCH_CLAUDE_BINARY;
  delete process.env.TASK_ORCH_CLAUDE_BINARY;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv == null) delete process.env.TASK_ORCH_CLAUDE_BINARY;
  else process.env.TASK_ORCH_CLAUDE_BINARY = savedEnv;
});

function fakeBinary(mode: number): string {
  const p = join(dir, "claude");
  writeFileSync(p, "#!/bin/sh\necho fake-claude 1.0.0\n");
  chmodSync(p, mode);
  return p;
}

describe("resolveClaudeBinary", () => {
  it("returns undefined when TASK_ORCH_CLAUDE_BINARY is unset (SDK bundled binary)", () => {
    expect(resolveClaudeBinary()).toBeUndefined();
  });

  it("returns the path when it points at an executable file", () => {
    const p = fakeBinary(0o755);
    process.env.TASK_ORCH_CLAUDE_BINARY = p;
    expect(resolveClaudeBinary()).toBe(p);
  });

  it("throws naming the path and env var when the file is missing", () => {
    process.env.TASK_ORCH_CLAUDE_BINARY = join(dir, "no-such-claude");
    expect(() => resolveClaudeBinary()).toThrow(/TASK_ORCH_CLAUDE_BINARY/);
    expect(() => resolveClaudeBinary()).toThrow(/no-such-claude/);
  });

  it("throws when the file exists but is not executable", () => {
    const p = fakeBinary(0o644);
    process.env.TASK_ORCH_CLAUDE_BINARY = p;
    expect(() => resolveClaudeBinary()).toThrow(/not executable|missing or not executable/);
  });

  it("throws when the path is a directory", () => {
    process.env.TASK_ORCH_CLAUDE_BINARY = dir;
    expect(() => resolveClaudeBinary()).toThrow(/TASK_ORCH_CLAUDE_BINARY/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/agent-backend/claude-binary.test.ts`
Expected: FAIL — `Cannot find module '../../lib/agent-backend/claude-binary'` (or "resolveClaudeBinary is not a function").

- [ ] **Step 3: Add the config getter**

In `lib/config.ts`, inside the `agent: Object.freeze({ ... })` block (after the `backend` getter, ~line 322), add:

```ts
    /** Absolute path to an external Claude Code executable for the Claude
     *  backend to drive instead of the SDK's bundled platform binary.
     *  Explicit-only — never probed from PATH. Set by the Box worker env
     *  (the Box image ships /usr/local/bin/claude); unset everywhere else. */
    get claudeBinary(): string | undefined {
      return strEnv("TASK_ORCH_CLAUDE_BINARY");
    },
```

- [ ] **Step 4: Write the minimal implementation**

Create `lib/agent-backend/claude-binary.ts`:

```ts
// lib/agent-backend/claude-binary.ts
//
// Resolution of the external Claude Code executable (spec:
// docs/superpowers/specs/2026-07-18-standalone-worker-bundle-design.md §1).
// Explicit-only: TASK_ORCH_CLAUDE_BINARY set → validate and use it; unset →
// undefined, and the SDK falls back to its bundled platform binary. There is
// deliberately NO PATH auto-detection — probing would silently pair an
// arbitrary locally-installed CLI with the SDK on every dev machine.

import { accessSync, constants, statSync } from "node:fs";
import { config } from "../config";

export function resolveClaudeBinary(): string | undefined {
  const path = config.agent.claudeBinary;
  if (!path) return undefined;
  try {
    if (!statSync(path).isFile()) throw new Error("not a regular file");
    accessSync(path, constants.X_OK);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `TASK_ORCH_CLAUDE_BINARY points at '${path}', which is missing or not executable (${reason}). ` +
        `Unset it to use the Claude Agent SDK's bundled binary, or point it at a working Claude Code executable.`
    );
  }
  return path;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run __tests__/agent-backend/claude-binary.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add lib/agent-backend/claude-binary.ts lib/config.ts __tests__/agent-backend/claude-binary.test.ts
git commit -m "feat(agent): TASK_ORCH_CLAUDE_BINARY resolution for an external Claude Code executable"
```

---

### Task 2: Wire the external binary into ClaudeBackend

**Files:**
- Modify: `lib/agent-backend/claude-backend.ts`
- Test: `__tests__/agent-backend/claude-binary-wiring.test.ts` (create)

**Interfaces:**
- Consumes: `resolveClaudeBinary()` from Task 1.
- Produces: `ClaudeBackend` constructed with `new ClaudeBackend()` throws immediately on a broken `TASK_ORCH_CLAUDE_BINARY`; `query()` receives `options.pathToClaudeCodeExecutable` when the var is set and omits it when unset. No other `RunTurnArgs`/`TurnOutcome` changes.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/agent-backend/claude-binary-wiring.test.ts` (SDK mock harness mirrors `claude-spawn-retry.test.ts`):

```ts
// __tests__/agent-backend/claude-binary-wiring.test.ts
//
// The backend must hand TASK_ORCH_CLAUDE_BINARY to the SDK as
// pathToClaudeCodeExecutable — and validate it at construction, so a bad
// path fails with an actionable error instead of a mid-run spawn error.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeBackend } from "../../lib/agent-backend/claude-backend";
import type { RunTurnArgs } from "../../lib/agent-backend/types";

const sdk = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (cfg: any) => ({ ...cfg }),
  tool: (name: string) => ({ name }),
  query: (arg: any) => {
    sdk.calls.push(arg);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        num_turns: 1,
        session_id: "s1",
        total_cost_usd: 0.01,
        usage: { input_tokens: 5, output_tokens: 3 },
      };
    })();
  },
}));

function makeArgs(): RunTurnArgs {
  return {
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    extensions: [],
    resumeToken: null,
    abort: new AbortController(),
    prompt: "do the thing",
    onEvent: () => {},
  };
}

let dir: string;
let savedEnv: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-wiring-"));
  savedEnv = process.env.TASK_ORCH_CLAUDE_BINARY;
  delete process.env.TASK_ORCH_CLAUDE_BINARY;
  sdk.calls.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv == null) delete process.env.TASK_ORCH_CLAUDE_BINARY;
  else process.env.TASK_ORCH_CLAUDE_BINARY = savedEnv;
});

describe("ClaudeBackend external binary wiring", () => {
  it("passes pathToClaudeCodeExecutable when TASK_ORCH_CLAUDE_BINARY is set", async () => {
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\necho fake-claude 1.0.0\n");
    chmodSync(bin, 0o755);
    process.env.TASK_ORCH_CLAUDE_BINARY = bin;

    await new ClaudeBackend().runTurn(makeArgs());

    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].options.pathToClaudeCodeExecutable).toBe(bin);
  });

  it("omits pathToClaudeCodeExecutable when unset (SDK bundled binary)", async () => {
    await new ClaudeBackend().runTurn(makeArgs());
    expect(sdk.calls[0].options.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("fails at construction — not mid-run — when the configured path is broken", () => {
    process.env.TASK_ORCH_CLAUDE_BINARY = join(dir, "no-such-claude");
    expect(() => new ClaudeBackend()).toThrow(/TASK_ORCH_CLAUDE_BINARY/);
    expect(sdk.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/agent-backend/claude-binary-wiring.test.ts`
Expected: FAIL — test 1 fails with `pathToClaudeCodeExecutable` being `undefined`; test 3 fails because construction does not throw. Test 2 may already pass (that's fine — it pins today's behavior).

- [ ] **Step 3: Implement the wiring**

In `lib/agent-backend/claude-backend.ts`:

Add imports (top of file, with the other imports):

```ts
import { execFile } from "node:child_process";
import { resolveClaudeBinary } from "./claude-binary";
```

In the `ClaudeBackend` class, directly under `readonly id = "claude" as const;`, add:

```ts
  /** Resolved (and validated) at construction so a broken
   *  TASK_ORCH_CLAUDE_BINARY fails loud and early, not as the SDK's opaque
   *  spawn error milliseconds into a run (the run 26/27 failure mode). */
  private readonly externalClaudeBinary = resolveClaudeBinary();
  private loggedBinary = false;
```

At the top of `runTurn`, right after the destructuring of `args` (after the `const { cwd, model, ... } = args;` line), add:

```ts
    // Runs 26/27 cost hours because nothing recorded which claude binary a
    // worker actually drove. Record it (and its version) once per backend.
    if (!this.loggedBinary) {
      this.loggedBinary = true;
      if (this.externalClaudeBinary) {
        const bin = this.externalClaudeBinary;
        execFile(bin, ["--version"], (err, stdout) => {
          console.error(
            `[ClaudeBackend] external claude binary ${bin}: ` +
              (err ? `--version failed: ${err.message}` : String(stdout).trim())
          );
        });
      }
    }
```

In the `query({ options: { ... } })` object, directly under the `cwd,` line, add:

```ts
          ...(this.externalClaudeBinary
            ? { pathToClaudeCodeExecutable: this.externalClaudeBinary }
            : {}),
```

- [ ] **Step 4: Run the new tests and the existing Claude backend suites**

Run: `npx vitest run __tests__/agent-backend/claude-binary-wiring.test.ts __tests__/agent-backend/claude-spawn-retry.test.ts __tests__/agent-backend/claude-binary.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/agent-backend/claude-backend.ts __tests__/agent-backend/claude-binary-wiring.test.ts
git commit -m "feat(agent): drive an external Claude Code executable via pathToClaudeCodeExecutable"
```

---

### Task 3: Extend the spawn-failure detection to explicit-path errors

**Files:**
- Modify: `lib/agent-backend/claude-backend.ts:47` (`SPAWN_FAILURE_RE`) and the `__test` export (~line 99)
- Test: `__tests__/agent-backend/claude-spawn-retry.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `__test.isSpawnFailure(message: string): boolean` — the retry-classification predicate, exported for direct unit testing. Retry behavior itself is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/agent-backend/claude-spawn-retry.test.ts`:

```ts
describe("spawn-failure classification", () => {
  // With pathToClaudeCodeExecutable set, the SDK's launch errors use
  // different text than the bundled-binary path. All of them are
  // infrastructure faults and must be retryable.
  it("classifies bundled-binary, explicit-path, and generic spawn errors as retryable", () => {
    const retryable = [
      SPAWN_ERR, // bundled: "native binary at <path> exists but failed to launch"
      "Claude Code executable at /usr/local/bin/claude exists but failed to launch",
      "Claude Code executable not found at /usr/local/bin/claude. Is options.pathToClaudeCodeExecutable set correctly?",
      "Failed to spawn Claude Code process: EAGAIN",
    ];
    for (const msg of retryable) {
      expect(__test.isSpawnFailure(msg), msg).toBe(true);
    }
  });

  it("does not classify ordinary agent errors as spawn failures", () => {
    expect(__test.isSpawnFailure("API rate limit exceeded")).toBe(false);
    expect(__test.isSpawnFailure("No conversation found with session ID: abc")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/agent-backend/claude-spawn-retry.test.ts`
Expected: FAIL — `__test.isSpawnFailure is not a function`.

- [ ] **Step 3: Implement**

In `lib/agent-backend/claude-backend.ts`, replace the `SPAWN_FAILURE_RE` constant (line 47) with:

```ts
/** The SDK's errors when its child process dies at spawn. Three shapes:
 *  bundled-binary ("native binary at <path> exists but failed to launch",
 *  run 26), explicit-path via pathToClaudeCodeExecutable ("executable at
 *  <path> exists but failed to launch" / "not found at <path>. Is
 *  options.pathToClaudeCodeExecutable set correctly?"), and the generic
 *  "Failed to spawn Claude Code process". All are infrastructure faults, not
 *  agent errors, so the launch is retried with settle delays instead of
 *  failing the run milliseconds into its turn. */
const SPAWN_FAILURE_RE =
  /(?:native binary|executable) at .*(?:exists but )?failed to launch|Failed to spawn Claude Code process|not found at .*pathToClaudeCodeExecutable/i;
```

In the `__test` export object, add:

```ts
  isSpawnFailure(message: string): boolean {
    return SPAWN_FAILURE_RE.test(message);
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/agent-backend/claude-spawn-retry.test.ts`
Expected: all pass (4 existing retry tests + 2 new classification tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent-backend/claude-backend.ts __tests__/agent-backend/claude-spawn-retry.test.ts
git commit -m "feat(agent): treat explicit-path SDK launch errors as retryable spawn failures"
```

---

### Task 4: Inject `TASK_ORCH_CLAUDE_BINARY` into the Box worker environment

**Files:**
- Modify: `lib/runner/box-env.ts` (`buildBoxWorkerEnv`, the `env` object ~line 86)
- Test: `__tests__/box-env.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: every Box worker env contains `TASK_ORCH_CLAUDE_BINARY=/usr/local/bin/claude`. Task 6's verify step and the reshaped template rely on this exact path.

- [ ] **Step 1: Write the failing test**

Append inside the existing describe block of `__tests__/box-env.test.ts` (it already defines a valid `CHANNEL_INSTANCE_ID` constant — reuse it):

```ts
  it("pins the Box's preinstalled Claude Code binary for the worker", () => {
    const env = buildBoxWorkerEnv({ runId: 42, repoId: "repo_123", channelInstanceId: CHANNEL_INSTANCE_ID });
    expect(env.TASK_ORCH_CLAUDE_BINARY).toBe("/usr/local/bin/claude");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/box-env.test.ts`
Expected: FAIL — `expected undefined to be '/usr/local/bin/claude'`.

- [ ] **Step 3: Implement**

In `lib/runner/box-env.ts`, add a module-level constant below `DEFAULT_SESSION_ROOT` (line 14):

```ts
/** The Box image ships Claude Code preinstalled at this fixed path. The
 *  worker's Claude backend drives it via pathToClaudeCodeExecutable; the
 *  template omits the SDK's 251MB bundled binary (`npm ci --omit=optional`). */
export const BOX_CLAUDE_BINARY = "/usr/local/bin/claude";
```

In `buildBoxWorkerEnv`, inside the `env` object literal (after `SESSION_ROOT: ...`), add:

```ts
    TASK_ORCH_CLAUDE_BINARY: BOX_CLAUDE_BINARY,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/box-env.test.ts`
Expected: all pass. (`TASK_ORCH_CLAUDE_BINARY` is not a secret — no `isSensitiveBoxWorkerEnvKey` change; the pattern there does not match it.)

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-env.ts __tests__/box-env.test.ts
git commit -m "feat(box): point workers at the Box's preinstalled claude binary"
```

---

### Task 5: `build:worker:standalone` target + isolation regression test

**Files:**
- Create: `scripts/build-worker-standalone.mjs`
- Modify: `package.json` (scripts block, next to `build:worker` at line 23)
- Test: `__tests__/worker-standalone-bundle.test.ts` (create)

**Interfaces:**
- Consumes: `scripts/run-worker.ts` (existing worker entrypoint; exits 2 with usage when called without a run id).
- Produces: `npm run build:worker:standalone` → `dist/run-worker.standalone.js`, a single self-contained ESM file. Task 6's template build and verify step consume it.

- [ ] **Step 1: Write the failing test**

Create `__tests__/worker-standalone-bundle.test.ts`:

```ts
// __tests__/worker-standalone-bundle.test.ts
//
// Regression guard for the standalone worker bundle (spec §2): built, copied
// ALONE into an empty directory (no node_modules, no repo), it must reach its
// own argument check — exit 2 with the usage message. Any future import that
// reintroduces a node_modules or native dependency fails here, at build time,
// instead of inside a Box template at run time.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone worker bundle", () => {
  it("builds, and runs alone in an empty directory to exit 2 (usage)", () => {
    execFileSync("npm", ["run", "build:worker:standalone"], { stdio: "pipe", timeout: 120_000 });

    const dir = mkdtempSync(join(tmpdir(), "worker-bundle-iso-"));
    try {
      copyFileSync("dist/run-worker.standalone.js", join(dir, "run-worker.js"));
      const res = spawnSync(process.execPath, ["run-worker.js"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(res.status).toBe(2);
      expect(`${res.stdout}${res.stderr}`).toMatch(/usage: run-worker/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/worker-standalone-bundle.test.ts`
Expected: FAIL — `npm run build:worker:standalone` exits non-zero ("Missing script: build:worker:standalone").

- [ ] **Step 3: Implement the build script**

Create `scripts/build-worker-standalone.mjs`:

```js
// scripts/build-worker-standalone.mjs
//
// Standalone worker bundle for Box templates (spec:
// docs/superpowers/specs/2026-07-18-standalone-worker-bundle-design.md §2).
// Unlike `build:worker` (--packages=external, needs a real node_modules at
// runtime), this bundles EVERY runtime dependency into one file so a Box
// needs no node_modules for the worker at all.
import { build } from "esbuild";

// This banner is LOAD-BEARING, not cosmetic. CJS dependencies compiled into
// the ESM bundle (dotenv and others) call require("fs") at runtime, which an
// ESM module cannot satisfy on its own. Removing it makes the bundle throw
// `Dynamic require of "fs" is not supported` at startup.
const banner = [
  'import { createRequire as __cr } from "node:module";',
  "const require = __cr(import.meta.url);",
].join("\n");

await build({
  entryPoints: ["scripts/run-worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { "@": "." },
  // dockerode drags native .node addons (ssh2 → cpu-features) into the graph
  // and is only reached via dynamic `await import("dockerode")` on
  // control-plane dispatch paths a worker never executes (spec §3). Keeping
  // it external is what makes this bundle standalone-clean; do not remove
  // this without first splitting the dispatch seam.
  external: ["dockerode"],
  banner: { js: banner },
  outfile: "dist/run-worker.standalone.js",
});
```

In `package.json`, directly after the `"build:worker"` script line, add:

```json
    "build:worker:standalone": "node scripts/build-worker-standalone.mjs",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/worker-standalone-bundle.test.ts`
Expected: PASS. Also sanity-check the artifact size: `ls -lh dist/run-worker.standalone.js` — expect ~20–25MB.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-worker-standalone.mjs package.json __tests__/worker-standalone-bundle.test.ts
git commit -m "feat(worker): standalone single-file worker bundle with isolation regression test"
```

---

### Task 6: Reshape the app-managed Box template build

**Files:**
- Modify: `lib/runner/box-template-builder.ts` (steps array line 16, commands lines 149–179, `VERIFY_WORKER_COMMAND` line 38)
- Modify: `lib/runner/box-template-events.ts` (`STEP_LABELS`, line 166)
- Test: `__tests__/box-template-builder.test.ts`, `__tests__/box-template-events.test.ts`

**Interfaces:**
- Consumes: `npm run build:worker:standalone` (Task 5); `/usr/local/bin/claude` on the Box image (Task 4's constant — import `BOX_CLAUDE_BINARY` from `./box-env`).
- Produces: templates whose only worker artifact is `/home/user/worker/run-worker.js`; manifest JSON gains `"workerEntryPath":"/home/user/worker/run-worker.js"` (the parser tolerates unknown keys — no `box-template.ts` change). Step list (still 8): `cloning-worker, installing-deps, building-worker, pruning, cloning-agent-repo, writing-manifest, verifying-worker, archiving`. Task 7's bootstrap consumes the entry path.

- [ ] **Step 1: Update the tests (failing first)**

In `__tests__/box-template-builder.test.ts`, in the first test ("creates a blank box, builds, archives…"), replace the verify-related assertions (lines 98–103, the comment plus the `verify` const and its two expects) with:

```ts
    // Before archiving, the build (a) runs the standalone bundle in isolation
    // — its own usage check, exit 2, proves the full dependency graph loads
    // with no node_modules — and (b) execs the Box's preinstalled claude
    // binary, then syncs so the checkpoint can't seal half-written pages.
    const verify = commands.find((c) => c.includes("/usr/local/bin/claude --version"));
    expect(verify).toBeDefined();
    expect(verify).toContain("run-worker.js");
    expect(verify).toContain("sync");
    // The reshaped build installs without the SDK's 251MB optional platform
    // binary, builds the standalone bundle, prunes the checkout, and never
    // npm-installs the agent repo (deps are on-demand at run time).
    expect(commands.some((c) => c.includes("npm ci --omit=optional"))).toBe(true);
    expect(commands.some((c) => c.includes("build:worker:standalone"))).toBe(true);
    expect(commands.some((c) => c.includes("rm -rf") && c.includes("/home/user/task-orchestrator"))).toBe(true);
    expect(commands.some((c) => c.includes("workerEntryPath"))).toBe(true);
    expect(commands.some((c) => c.includes("/home/user/repository") && c.includes("npm ci"))).toBe(false);
```

In the second test ("marks the row failed when the pre-archive binary smoke test fails"), the `failOn: /--version/` fixture and its assertions still apply unchanged — the new verify command still contains `--version`.

In `__tests__/box-template-events.test.ts`, append next to the existing label test:

```ts
  it("labels the pruning step", () => {
    const state = reduceTemplateBuildEvent(
      null,
      { type: "runner_box_template_building", steps: ["pruning"] },
      0
    );
    const view = templateBuildView(state!, 0);
    expect(view.steps[0].label).toBe("Pruning build artifacts");
  });
```

(Match the import/helper style already used by that file's "labels the pre-archive verification step" test; if it builds state differently, mirror that construction with the step name `"pruning"` and the same label assertion.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/box-template-builder.test.ts __tests__/box-template-events.test.ts`
Expected: FAIL — no command contains `/usr/local/bin/claude --version`, `npm ci --omit=optional`, etc.; the label test fails with `"pruning"` (fallback label) instead of `"Pruning build artifacts"`.

- [ ] **Step 3: Implement the builder reshape**

In `lib/runner/box-template-builder.ts`:

Add the import:

```ts
import { BOX_CLAUDE_BINARY } from "./box-env";
```

Replace the `BUILD_STEPS` array (line 16) with:

```ts
const BUILD_STEPS = [
  "cloning-worker",
  "installing-deps",
  "building-worker",
  "pruning",
  "cloning-agent-repo",
  "writing-manifest",
  "verifying-worker",
  "archiving",
] as const;
```

Below `const WORKER_DIR = "/home/user/task-orchestrator";` add:

```ts
/** Where the pruning step parks the single-file worker; the ONLY worker
 *  artifact a finished template contains. The bootstrap in box.ts launches
 *  this path (with a legacy fallback for pre-bundle templates). */
const BUNDLE_PATH = "/home/user/worker/run-worker.js";
```

Replace `VERIFY_WORKER_COMMAND` (lines 29–44, including its doc comment) with:

```ts
/**
 * Pre-archive smoke test. Run 26 archived a snapshot whose claude binary
 * could not exec; runs 26/27 then died milliseconds into their first turn.
 * Verify BOTH launch paths the worker depends on: (a) the standalone bundle,
 * copied alone into a scratch dir so a hidden node_modules dependency cannot
 * pass by accident (exit 2 = its own usage check, the full dependency graph
 * loaded), and (b) the Box's preinstalled claude binary. `sync` so the
 * checkpoint can never seal half-written pages.
 */
const VERIFY_WORKER_COMMAND =
  `set -eu; d=$(mktemp -d); cp ${BUNDLE_PATH} "$d/run-worker.js"; cd "$d"; ` +
  `node run-worker.js >/dev/null 2>&1 || rc=$?; test "\${rc:-0}" -eq 2 || { echo "bundle isolation check failed (exit \${rc:-0}, expected 2)" >&2; exit 1; }; ` +
  `${BOX_CLAUDE_BINARY} --version; sync`;
```

Replace the step invocations between `cloning-worker` and `writing-manifest` (lines 153–165) with:

```ts
        await stepAndDetail("installing-deps");
        await run(boxId, "installing-deps",
          `set -eu; cd ${shq(WORKER_DIR)}; npm ci --omit=optional`);

        await stepAndDetail("building-worker");
        await run(boxId, "building-worker",
          `set -eu; cd ${shq(WORKER_DIR)}; npm run build:worker:standalone; test -s dist/run-worker.standalone.js`);

        await stepAndDetail("pruning");
        await run(boxId, "pruning",
          `set -eu; mkdir -p $(dirname ${shq(BUNDLE_PATH)}); cp ${shq(`${WORKER_DIR}/dist/run-worker.standalone.js`)} ${shq(BUNDLE_PATH)}; rm -rf ${shq(WORKER_DIR)}`);

        await stepAndDetail("cloning-agent-repo");
        await run(boxId, "cloning-agent-repo",
          `set -eu; test ! -e ${shq(repoPath)}; git clone --depth 1 ${shq(config.box.agentRepoUrl)} ${shq(repoPath)}`);
```

(The `installing-agent-deps` step invocation is deleted entirely.)

In the `writing-manifest` step, add `workerEntryPath` to the manifest object:

```ts
        const manifest = JSON.stringify({
          formatVersion: 1,
          workerBuildSha: input.workerSha,
          workerProtocolVersion: BOX_TEMPLATE_WORKER_PROTOCOL_VERSION,
          repository: config.box.agentRepo,
          repositoryPath: repoPath,
          workerEntryPath: BUNDLE_PATH,
        });
```

(`parseBoxTemplateManifest` tolerates unknown keys by design — no schema change.)

In `lib/runner/box-template-events.ts`, add to `STEP_LABELS` (after `"building-worker"`):

```ts
  "pruning": "Pruning build artifacts",
```

Keep the `"installing-agent-deps"` label — old runs' event replays still render it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/box-template-builder.test.ts __tests__/box-template-events.test.ts`
Expected: all pass (step-count assertions expect 8 events — the list is still 8 long).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-template-builder.ts lib/runner/box-template-events.ts __tests__/box-template-builder.test.ts __tests__/box-template-events.test.ts
git commit -m "feat(box): template bakes only the standalone worker bundle, drops agent-repo npm ci"
```

---

### Task 7: Bootstrap launches the bundle (with legacy fallback)

**Files:**
- Modify: `lib/runner/box.ts:76` (`WORKER_BOOTSTRAP_COMMAND` entry line)
- Test: `__tests__/box-provider-e2e.test.ts` (bootstrap syntax test, ~line 151)

**Interfaces:**
- Consumes: `/home/user/worker/run-worker.js` baked by Task 6.
- Produces: a bootstrap that runs new-style templates from the bundle and pre-reshape templates from the legacy `dist/run-worker.js` path, so nothing breaks while old templates remain in the registry.

- [ ] **Step 1: Write the failing test**

In `__tests__/box-provider-e2e.test.ts`, in the bootstrap test around line 151, add these assertions next to the existing ones:

```ts
    // New templates bake only the standalone bundle; old templates keep the
    // checkout layout. The bootstrap probes new-then-legacy so both launch.
    expect(WORKER_BOOTSTRAP_COMMAND).toContain('/home/user/worker/run-worker.js');
    expect(WORKER_BOOTSTRAP_COMMAND).toContain('/home/user/task-orchestrator/dist/run-worker.js');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/box-provider-e2e.test.ts`
Expected: FAIL — the command does not contain `/home/user/worker/run-worker.js`. (Ignore the two known pre-existing flakes listed in Global Constraints if they appear; they are in different files.)

- [ ] **Step 3: Implement**

In `lib/runner/box.ts`, replace the single entry line (line 76):

```ts
  'entry="/home/user/task-orchestrator/dist/run-worker.js"',
```

with:

```ts
  // New-style templates bake the standalone bundle at /home/user/worker;
  // pre-bundle templates still carry the full checkout. Probe new-then-legacy
  // so a control-plane deploy never strands an already-archived template.
  'entry="/home/user/worker/run-worker.js"',
  'if [ ! -f "$entry" ]; then entry="/home/user/task-orchestrator/dist/run-worker.js"; fi',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/box-provider-e2e.test.ts`
Expected: the bootstrap test passes, including the existing `sh -n` syntax check over the modified command.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box.ts __tests__/box-provider-e2e.test.ts
git commit -m "feat(box): bootstrap launches the standalone bundle with legacy-template fallback"
```

---

### Task 8: Mirror the reshape in `scripts/install-box-template.sh`

**Files:**
- Modify: `scripts/install-box-template.sh` (the `run_step` sequence after "clone Task Orchestrator")

**Interfaces:**
- Consumes: the same step semantics as Task 6 (the repo invariant: script and builder stay mirrored).
- Produces: an operator-driven template with the identical filesystem shape (`/home/user/worker/run-worker.js`, no worker checkout, no nodetool `node_modules`).

- [ ] **Step 1: Edit the script**

In `scripts/install-box-template.sh`, replace the block from `run_step "install Task Orchestrator dependencies"` through `run_step "install nodetool dependencies"` with:

```bash
run_step "install Task Orchestrator dependencies" \
  "set -eu; cd $(quote "$task_orch_dir"); npm ci --omit=optional"

run_step "build Task Orchestrator worker (standalone bundle)" \
  "set -eu; cd $(quote "$task_orch_dir"); npm run build:worker:standalone; test -s dist/run-worker.standalone.js"

# Record the SHA before pruning deletes the checkout; the manifest step needs it.
run_step "record worker SHA" \
  "set -eu; git -C $(quote "$task_orch_dir") rev-parse HEAD > /home/user/.task-orchestrator-worker-sha"

run_step "prune worker checkout" \
  "set -eu; mkdir -p /home/user/worker; cp $(quote "$task_orch_dir")/dist/run-worker.standalone.js /home/user/worker/run-worker.js; rm -rf $(quote "$task_orch_dir")"

run_step "clone nodetool" \
  "set -eu; test ! -e $(quote "$nodetool_dir"); git clone --depth 1 --branch $(quote "$nodetool_ref") $(quote "$nodetool_url") $(quote "$nodetool_dir")"
```

(The `install nodetool dependencies` step is deleted — agent-repo deps are on-demand.)

Replace the `write template manifest` step with:

```bash
run_step "write template manifest" \
  "set -eu; mkdir -p /home/user/.task-orchestrator; sha=\$(cat /home/user/.task-orchestrator-worker-sha); rm -f /home/user/.task-orchestrator-worker-sha; printf '{\"formatVersion\":1,\"workerBuildSha\":\"%s\",\"workerProtocolVersion\":1,\"repository\":\"nodetool-ai/nodetool\",\"repositoryPath\":\"/home/user/nodetool\",\"workerEntryPath\":\"/home/user/worker/run-worker.js\"}\\n' \"\$sha\" > /home/user/.task-orchestrator/template.json"
```

Replace the `verify template artifacts` and `verify worker agent binary` steps with a single mirrored verify:

```bash
# Mirrors the "verifying-worker" step in lib/runner/box-template-builder.ts:
# run the bundle ALONE in a scratch dir (exit 2 = its own usage check, the
# full dependency graph loaded with no node_modules), exec the preinstalled
# claude binary, then sync so the archive can't seal half-written pages.
run_step "verify worker bundle and claude binary" \
  "set -eu; test -s /home/user/worker/run-worker.js; test -z \"\$(git -C $(quote "$nodetool_dir") status --porcelain=v1)\"; cat /home/user/.task-orchestrator/template.json; d=\$(mktemp -d); cp /home/user/worker/run-worker.js \"\$d/run-worker.js\"; cd \"\$d\"; node run-worker.js >/dev/null 2>&1 || rc=\$?; test \"\${rc:-0}\" -eq 2; /usr/local/bin/claude --version; sync"
```

- [ ] **Step 2: Verify the script parses**

Run: `bash -n scripts/install-box-template.sh`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/install-box-template.sh
git commit -m "feat(box): mirror the standalone-bundle template shape in install-box-template.sh"
```

---

### Task 9: Full-suite verification and live template build

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: green, except the two known pre-existing flakes listed in Global Constraints. If anything ELSE fails, fix it before proceeding — compare against a stash of your changes if unsure whether it is a regression.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3 (manual, needs Box credentials): live template build + timing**

Trigger a manual template build for the current worker SHA (the `/environments` page's build button, or the manual build API route) and record from its event timeline:
- total duration — expect **well under 4 minutes** (was ~11);
- `installing-deps` no longer downloads a `claude-agent-sdk-linux-*` platform package;
- `verifying-worker` passes (bundle exit 2 + `claude --version`).

Then dispatch a small Box run against the new template and confirm in its session log the line `[ClaudeBackend] external claude binary /usr/local/bin/claude: <version>` and a completed turn.

- [ ] **Step 4: Commit any fixes and report**

Report the measured build time and snapshot behavior back in the session. **Do not** start spec §5 (agent deps on demand): it is gated on measuring a real-Box `npm install` against the Bash tool's 600s ceiling, which is a separate decision for Matthias.

---

## Out of scope (tracked in the spec)

- Spec §5 (agent-repo deps on demand — prompt template changes): gated on the timeout measurement above.
- Spec §3 follow-up (splitting the dockerode seam out of `lib/run-dispatch.ts`): `--external:dockerode` is the correct v1 fix.
- Spec §6 (CI-published bundle distribution).
- `lib/runner/box-template-operator.ts` (legacy operator publish/validate flow, including its `pgrep`-on-legacy-path check): validates pre-reshape templates and is untouched; revisit if the operator flow is ever used to publish a bundle-style template.
