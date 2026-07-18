# Standalone worker bundle — design

**Date:** 2026-07-18
**Relates to:** `2026-07-18-environments-design.md` (environment identity),
`2026-07-17-box-app-managed-template-design.md` (the template build this
reshapes). Motivated by the run 26/27 postmortem — see
`docs/agent-caveats.md`.

## Problem

A Box template build takes ~11 minutes and is triggered by every new worker
SHA, on the run's critical path when no warm template exists. Measured from
run 27's event timeline:

| step | duration |
| --- | --- |
| `installing-deps` (worker `npm ci`) | 3m 38s |
| `installing-agent-deps` (nodetool `npm ci`) | 6m 44s |
| clone worker / build worker / clone agent / manifest / verify / archive | ~65s total |

**10m 22s of 11 minutes is two `npm ci` runs.** Everything else is a minute.
The worker *build* is 16ms and its clone is 8s, yet the template is keyed on
the worker commit — so the cheap thing invalidates the expensive snapshot on
every merge to `main`.

Two of the three installs are avoidable outright:

1. The Claude Agent SDK's platform binary (216MB darwin / 251MB linux) is an
   **optional dependency**. Every Box already ships `/usr/local/bin/claude`
   preinstalled. Installing a second copy is pure waste — and it is the exact
   artifact that failed to exec in runs 26/27.
2. The worker's remaining runtime dependencies can be **bundled into a single
   JS file**, so the Box needs no `node_modules` for the worker at all.

The agent repo's dependencies are genuinely optional per run (a review run
never builds), so they move to on-demand, installed by the agent.

## What was verified (2026-07-18)

Every claim below was proven, not assumed:

- **`pathToClaudeCodeExecutable` is supported** — `sdk.d.ts:1701`. Driving SDK
  `0.3.178` against an external CLI `2.1.214` (vs its bundled `2.1.178`)
  completed a full turn: init, result `is_error: false`, clean stream close.
  Patch-level version skew is fine.
- **The worker bundles standalone** — `esbuild --bundle --platform=node
  --format=esm --external:dockerode` plus a `createRequire` banner produces a
  22.6MB file in 327ms. Copied alone into an empty directory (no
  `node_modules`), `node w2.js` exits **2** with `[run-worker] usage:
  run-worker <runId>` — its own argument check, reached after the full
  dependency graph loaded.
- **`dockerode` is the only blocker** — its transitive natives (`ssh2`,
  `cpu-features`) are the sole `.node` files in the graph. It is reached only
  via dynamic `await import("dockerode")` at `lib/run-dispatch.ts:214` and
  `:1488`, and `lib/runner/docker-image-build.ts:78` — all control-plane
  container spawning, never executed in a worker.
- **The worker never runs migrations** — `migrate()` is called only from
  `db/index.ts:189` inside `initDb()`, which no worker entrypoint calls. No
  migration `.sql` files are needed in the Box.

## 1. Claude binary resolution

`lib/agent-backend/claude-backend.ts` passes no `pathToClaudeCodeExecutable`,
so the SDK resolves its bundled platform package.

Add `config.agent.claudeBinary` (`TASK_ORCH_CLAUDE_BINARY`). Resolution:

- **Set** → pass it as `pathToClaudeCodeExecutable`.
- **Unset** → pass nothing; the SDK uses its bundled binary (today's behavior).

**Explicit configuration, no auto-detection.** Probing `PATH` for `claude`
would silently change local-dev behavior on every machine that has Claude Code
installed, pairing an arbitrary CLI with the SDK. The Box is the only
environment that needs the override, and `buildBoxWorkerEnv` (`box-env.ts`)
already constructs its environment — it injects
`TASK_ORCH_CLAUDE_BINARY=/usr/local/bin/claude` there.

Validate once at backend construction: if the value is set but missing or not
executable, throw naming the path and the env var. A wrong path must fail with
an actionable message, never as the SDK's spawn error.

Log the resolved binary path and `--version` once per run at startup. Runs
26/27 cost hours precisely because nothing recorded which binary was used.

Extend `SPAWN_FAILURE_RE` to also match the SDK's explicit-path messages
(`Claude Code executable at ... exists but failed to launch`, `... not found at
... Is options.pathToClaudeCodeExecutable set?`).

## 2. Standalone worker bundle

New npm script alongside `build:worker`:

```
build:worker:standalone
  esbuild scripts/run-worker.ts --bundle --platform=node --format=esm
    --alias:@=. --external:dockerode
    --banner:js="<createRequire banner>"
    --outfile=dist/run-worker.standalone.js
```

The banner is **load-bearing**, not cosmetic — CJS dependencies (dotenv and
others) call `require("fs")`, which esbuild's ESM output cannot satisfy without
it. It must carry a comment saying so, or it will be "cleaned up":

```js
import { createRequire as __cr } from "node:module";
const require = __cr(import.meta.url);
```

`build:worker` (the `--packages=external` variant) stays for local and Docker
workers, which have a real `node_modules`. The standalone bundle is what ships
to a Box.

**Regression guard.** A CI job builds the bundle, copies *only* that file into
an empty temp directory, runs it, and asserts exit code 2. This is the same
smoke test `install-box-template.sh` already uses, and it is the only thing
that catches a future import silently reintroducing a `node_modules` or native
dependency.

## 3. Severing dockerode

`--external:dockerode` makes the bundle build, but leaves an import edge from
worker-reachable code to control-plane-only code. The dynamic import means it
never executes in a worker, so this is safe today and the flag is the correct
v1 fix.

It should not stay implicit. `lib/run-dispatch.ts` mixes control-plane
dispatch (Docker/Fly container spawning) with worker-reachable helpers; the
Docker monitor and image build belong behind a seam the worker never imports.
Tracked as follow-up work, not a prerequisite — but if the `--external` flag is
ever removed without that split, the build breaks on `.node` loaders again.

## 4. Template reshape

The Box template build (`lib/runner/box-template-builder.ts`, mirrored by
`scripts/install-box-template.sh`) becomes:

| step | change |
| --- | --- |
| `cloning-worker` | unchanged |
| `installing-deps` | `npm ci --omit=optional` — skips the 216/251MB platform binary |
| `building-worker` | `npm run build:worker:standalone` |
| *(new)* `pruning` | copy the bundle to `/home/user/worker/run-worker.js`; delete the worker checkout and its `node_modules` |
| `cloning-agent-repo` | unchanged |
| ~~`installing-agent-deps`~~ | **removed** — on-demand by the agent |
| `writing-manifest` | records the bundle path + worker SHA it was built from |
| `verifying-worker` | run the bundle in isolation (expect exit 2) **and** exec `$TASK_ORCH_CLAUDE_BINARY --version` |
| `archiving` | unchanged |

Expected: ~11min → well under 4min, and the archived snapshot loses ~2.5GB of
`node_modules` plus the 251MB binary.

`--omit=optional` is blunt — it drops every package's optional dependencies,
not just the SDK's. Known-affected: `bufferutil` / `utf-8-validate` (ws
performance addons, pure optimizations). The template build must verify the
bundle still runs, which the `verifying-worker` step now does.

The bootstrap (`WORKER_BOOTSTRAP_COMMAND` in `lib/runner/box.ts`) points its
`entry` at the bundle path instead of
`/home/user/task-orchestrator/dist/run-worker.js`.

## 5. Agent-repo dependencies on demand

Removing `installing-agent-deps` moves ~6m44s off the template build and onto
whichever runs actually need it. Two consequences must be handled:

**The agent must be told.** Without it, a run hits `cannot find module`, flails,
and burns turns rediscovering the cause. The implement/review prompt templates
(`lib/run-templates.ts`) gain a line: the repository's dependencies are not
installed; run `npm install` first if you need to build, test, or run the
project, and allow up to 10 minutes.

**The Bash tool timeout is a hard constraint.** Claude Code's Bash tool defaults
to 120s with a 600s maximum. A 6m44s `npm install` **exceeds the default** and
only just fits under the ceiling; on a slower Box it could exceed it outright.
**This must be measured on a real Box before this step ships** — if it does not
fit, the fallback is baking the agent repo's `node_modules` back into the
template (accepting the build cost) or seeding an npm cache.

This is a genuine trade, not a free win: work moves from a shared, free
template build into billable model time on runs that need it. It is worth it
because reviews, chats, and planning runs — the majority — never pay it, while
today every cold build blocks everyone.

## 6. Distribution — deferred

With the bundle baked into the template, updating worker code still requires a
template rebuild (now minutes, not 11). A future step publishes the bundle as a
CI release artifact so a Box can `curl` a fresh worker at launch, decoupling
worker updates from template rebuilds entirely and finally making environment
identity independent of the worker commit.

Not in scope here. It needs a CI publishing pipeline and a trust/verification
story for the fetched artifact, and the template-baked bundle already captures
most of the win.

**Status 2026-07-18:** the publishing half exists — CI's `worker-bundle` job
(`.github/workflows/ci.yml`) builds the bundle on every code push to `main`,
smoke-tests it in isolation, and uploads `worker-bundle-<sha>` (bundle +
sha256 + manifest) as a 90-day workflow artifact. Nothing consumes it yet;
fetch-at-launch remains open.

## Rollout

Ordered so each phase is independently valuable and revertible:

1. **Binary resolution** (§1) — unblocks `--omit=optional`; no template change.
2. **Bundle target + CI isolation test** (§2) — build artifact only, nothing
   consumes it yet.
3. **Template reshape** (§4) — switch the build and bootstrap to the bundle.
4. **Agent deps on demand** (§5) — gated on the Bash-timeout measurement.
5. **dockerode seam** (§3) and **distribution** (§6) — follow-ups.

## Risks

| risk | mitigation |
| --- | --- |
| Box's preinstalled CLI drifts from a version the SDK can drive | Log resolved binary + version per run; keep the bundled binary as the unset-default so local/Docker are unaffected; skew proved fine across 2.1.178 → 2.1.214 |
| `--omit=optional` drops something load-bearing | `verifying-worker` runs the bundle in isolation before archiving |
| A new import reintroduces a native/`node_modules` dependency | CI isolation test (exit 2 in an empty dir) |
| `npm install` exceeds the Bash tool ceiling | Measure on a real Box before shipping §5; fallback is re-baking agent deps |
| Bundle staleness — template pins the worker commit again | Accepted for now; §6 removes it |

## Out of scope

- Per-run environment selection (no `environment_id` on `agent_runs`).
- The cwd/admission fixes from the run 26/27 postmortem (already landed).
- Fly and Docker worker packaging — they keep `build:worker` + real
  `node_modules`.
