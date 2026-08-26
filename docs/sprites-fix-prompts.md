# Sprites runner: fix prompts

Each section is a self-contained prompt for one agent task. Run them in
order. Each prompt assumes the staged Sprites diff (commit it first) and
`docs/sprites-migration-design.md` as context.

---

## Prompt 1 — Deduplicate the `sprite://` endpoint parser and proxy URL

Context: `lib/worker-channel/dispatch-env.ts:119` (`parseSpritesDialEndpoint`),
`lib/worker-channel/connection.ts:117` (`parseSpritesEndpoint`), and
`lib/runner/sprites-tunnel.ts:16` (`parseSpritesTarget`) parse the same
`sprite://<name>:<port>/worker/channel` string. `lib/runner/sprites-client.ts:281`
(`proxyUrl`) and `lib/runner/sprites-tunnel.ts:30` (`spritesProxyUrl`) both build
the proxy WSS URL.

Task:

1. Keep `parseSpritesDialEndpoint` and `isSpritesDialEndpoint` in
   `dispatch-env.ts` as the single parser. Delete the two copies and import
   from `dispatch-env.ts`. `sprites-tunnel.ts` may re-export the parsed type
   as `SpritesProxyTarget`.
2. Keep `spritesProxyUrl` in `sprites-tunnel.ts` as the single URL builder.
   Make it take `baseUrl` as an argument with `config.sprites.baseUrl` as the
   default. Have `SpritesClient.proxyUrl` call it with the client's own
   `baseUrl`.
3. Add `__tests__/sprites-endpoint.test.ts` with cases for
   `parseSpritesDialEndpoint`: valid endpoint, missing path suffix, missing
   port, port out of range, sprite name that contains a colon-free dash, and a
   `ws://` endpoint returns null. Also test `spritesProxyUrl` converts
   `https://api.sprites.dev/v1/` (trailing slash) to
   `wss://api.sprites.dev/v1/sprites/to-run-1/proxy`.

Run `npx tsc --noEmit -p .` and `npx vitest run __tests__/sprites-endpoint.test.ts`.

---

## Prompt 2 — Remove the token-less localhost fallback from the channel dialer

Context: `lib/worker-channel/connection.ts`, method `createSpritesProxiedSocket`.
When `config.sprites.token` is unset it dials `ws://127.0.0.1:<port>/worker/channel`
directly. That is test plumbing in production code and silently bypasses the
authenticated proxy.

Task:

1. When the token is unset, throw
   `new ControllerProtocolError("SPRITES_TOKEN is required to dial sprite:// endpoints", CLOSE_CODE_SCOPE_MISMATCH, false)`.
   Check the close code choice against the existing codes in
   `lib/worker-channel/protocol.ts`; pick a non-retryable one.
2. Add a constructor option on `ControllerConnection` named `openTunnel`
   (type: `(target: {spriteName: string; port: number}) => Promise<Duplex>`).
   Default it to `openSpritesProxyTunnel` from `../runner/sprites-tunnel`.
   Use it instead of the dynamic import.
3. Keep the `createSocket` injection for the inner WebSocket unchanged.
4. Add a test in `__tests__/worker-channel-connection.test.ts` (find the
   existing connection test file and extend it) that:
   - injects a fake `openTunnel` returning a `PassThrough`-based Duplex pair,
   - injects a fake `createSocket` that records the `createConnection` option,
   - asserts the inner dial URL is `ws://localhost:8787/worker/channel` and the
     `Authorization` header carries the minted channel credential,
   - asserts a missing token rejects with the protocol error and never calls
     `createSocket`.

Run typecheck and the connection tests.

---

## Prompt 3 — Fix `resume()` state and remove dead `stop()` fallback

Context: `lib/runner/sprites.ts`.

Task:

1. In `resume()`, line ~288 sets `state: runnerState === "suspended" ? "running" : runnerState`.
   Replace it with `state: "starting"`. Reason: the worker has not
   heartbeated yet; `nextLifecycleAction` returns `none` for `starting`, which
   is the protection the Fly provider gets from `wakeRequestedAt`. Do not set
   `wakeRequestedAt` for sprites.
2. Also in `resume()`, remove the nested `try { await x.catch(() => {}) } catch {}`.
   Log the `startService` failure with `console.warn` and continue.
3. In `stop()`, delete the `else` branch that queries
   `runnerInstances.machineId === handle`. Sprites rows never set `machineId`.
   If no row matches the sprite name, log at `warn` and return after the
   `deleteSprite` call.
4. In `stop()` and `applyLifecycle()`, drop `machineId: null, volumeId: null`
   from the update patch. Those columns are never set by this provider.
5. Add `__tests__/sprites-provider.test.ts` using a fake `SpritesClient`
   (implement the interface with `vi.fn()`s) and the test DB helper the Fly
   provider tests use (look at `__tests__/fly*.test.ts` for the pattern). Cover:
   - `spritesRunnerStateFromStatus` mapping for `running`, `warm`, `cold`,
     `destroyed`, and an unknown status.
   - `create()` on a fresh run: inserts the row with `provider: "sprites"`,
     `channelEndpoint: "sprite://to-run-<id>:8787/worker/channel"`, returns
     `handle === spriteName`.
   - `create()` when `createSprite` throws after a 409: proceeds without
     calling `deleteSprite`.
   - `create()` when `putService` throws: calls `deleteSprite` once and rethrows.
   - `resume()` on a `cold` sprite: row state becomes `starting`, `startService`
     called once.
   - `resume()` when `getSprite` returns null: row state `gone`, returns null.
   - `stop()`: calls `deleteSprite`, clears `workerScope` only when it equals
     the sprite name, nulls `sdkSessionId`.

Run typecheck and the new test file.

---

## Prompt 4 — Sprites-specific lifecycle predicate

Context: `lib/runner/lifecycle.ts` `nextLifecycleAction` and
`lib/runner/sprites.ts` `applyLifecycle`. The design (§3, "destroy") says
sprites collapse the lifecycle to one question: destroy or keep. Today
`applyLifecycle` reuses the Fly predicate and ignores `suspend`/`stop`. Because
a sprite is never in state `stopped`, the non-terminal branch at
`lifecycle.ts:171` never returns `archive-and-destroy`, so an abandoned
idle/parked run keeps its sprite forever.

Task:

1. Add `export function nextSpritesLifecycleAction(i: LifecycleInput): { kind: "none" } | { kind: "destroy" }`
   to `lib/runner/lifecycle.ts`. Rules, in order:
   - `runnerState` is `gone`, `creating`, or `starting` → `none`.
   - `isWorkerLive(i)` → `none`.
   - Terminal, non-conversational run (reuse `isTerminalStatus` and
     `isConversationalTerminal`) with `idleMs >= TASK_ORCH_RUNNER_TERMINAL_MS`
     (default 24h) → `destroy`.
   - Active run status → `none`.
   - Otherwise (idle/parked/conversational-terminal) with
     `idleMs >= TASK_ORCH_RUNNER_STOP_MS` (default 7d) → `destroy`.
   - Else `none`.
   Ignore `wakeRequestedAt` entirely; sprites do not use wake intents.
2. Rewrite `SpritesRunnerProvider.applyLifecycle` to call it. Keep the
   `archiveR2` gate and the `runner_archive_requested` event as they are.
   Remove `wakeRequestedAt` from the sweep select and the row type.
3. Add unit tests to `__tests__/lifecycle.test.ts` (extend the existing
   lifecycle test file) for each rule above with explicit `idleMs` values on
   both sides of each window.
4. Update the comment block above `nextLifecycleAction` to say it is the Fly
   predicate and point at the sprites one.

Run typecheck and the lifecycle tests.

---

## Prompt 5 — Make the orphan reaper pool-safe or remove it

Context: `SpritesRunnerProvider.reapOrphanSprites` in `lib/runner/sprites.ts`
deletes every sprite whose name starts with `config.sprites.prefix` and has no
`runner_instances` row, after a 10 minute grace. Phase 5 pool sprites are
named `${prefix}pool-<n>` and have no runner row, so the reaper would destroy
the warm pool.

Decision: keep the reaper (it covers a control-plane crash between
`createSprite` and the row insert) but make it strictly scoped.

Task:

1. Add `export function isRunSpriteName(name: string): boolean` to
   `lib/runner/sprites.ts`. It returns true only when `name` equals
   `${prefix}<digits>` with nothing else. Use a regexp built from an escaped
   prefix.
2. In `reapOrphanSprites`, replace the `startsWith` check with
   `isRunSpriteName`. Log each skipped non-run sprite once at `debug` level.
3. Make the grace window a config getter `config.sprites.orphanGraceMs`
   (`TASK_ORCH_SPRITES_ORPHAN_GRACE_MS`, default 10 minutes). Add it to
   `.env.example` under the Sprites block.
4. A sprite with `createdAt == null` (API returned no timestamp) must be
   skipped, never reaped. Currently the `&&` short-circuit reaps it.
5. Tests in `__tests__/sprites-provider.test.ts`: `isRunSpriteName` for
   `to-run-42`, `to-run-pool-1`, `to-run-42x`, `other-42`; `sweep()` with a
   fake client listing `[to-run-99 (old, no row), to-run-pool-1 (old, no row), to-run-7 (old, no row, createdAt null)]`
   deletes only `to-run-99`.

Run typecheck and the tests.

---

## Prompt 6 — Verify the Sprites API shapes (spike S5 + S4, partial)

Context: `lib/runner/sprites-client.ts` guesses response shapes
(`raw.sprite ?? raw`, `raw.status ?? raw.state`, `exit_code ?? exitCode`,
`continuation_token`). `lib/runner/sprites.ts:208` sends
`{ allow: domains }` as a network policy with an `as unknown as` cast.
`docs/sprites-migration-design.md` §2 and §9 (S4, S5) list what must be
confirmed.

Task:

1. Read the API docs at https://sprites.dev/api and its sub-pages for
   sprites, exec, services, checkpoints, policies, proxy. Use WebFetch.
2. For each client method, write the exact request body and response JSON
   into a new file `docs/runners/sprites-api-notes.md` with a link to the
   doc page. Note the list pagination field names, the sprite status enum,
   the exec POST body fields (is `timeout_ms` real?), the service PUT body,
   and the network policy body.
3. Fix `sprites-client.ts` to match the documented shapes. Remove every
   `?? alternativeFieldName` fallback that the docs do not justify. Replace
   `any` in the JSON parsers with narrow interfaces.
4. Replace `NetworkPolicy` with a typed shape from the docs, and rewrite the
   call in `sprites.ts` to build a real allowlist policy from
   `config.sprites.netAllow`. Remove the `as unknown as` cast.
5. Write `__tests__/sprites-client.test.ts` with a fake `fetchImpl` that
   asserts URL, method, headers (bearer token, content-type only with a body),
   and body for: `createSprite`, `getSprite` 404 → null, `deleteSprite` 404 →
   no throw, `listAllSprites` paging across two pages, `putService`,
   `setNetworkPolicy`, and a `TimeoutError` mapping to `SpritesApiError`
   with status 0.
6. Anything the docs leave unclear goes into a "Still unverified" section at
   the end of the notes file.

Run typecheck and the client tests.

---

## Prompt 7 — Feasibility script (spike S1, S2, S3)

Context: `docs/sprites-migration-design.md` §9. Model on
`scripts/fly-channel-probe.ts`. Needs a real `SPRITES_TOKEN`; the script is
for the operator to run, not CI.

Task: write `scripts/sprites-feasibility.ts` that, with `SPRITES_TOKEN` set:

1. Creates `to-spike-<timestamp>` via `makeSpritesClient()`.
2. S3: execs `node --version`, `git --version`, `python3 --version`, and
   `which ffmpeg pandoc pdftotext rg jq` and prints the results. Compare
   against the apt list in `Dockerfile.fly-runner` and print the delta.
3. S2: defines a service `echo` that runs
   `node -e "require('net').createServer(s=>s.pipe(s)).listen(8787)"`,
   starts it, opens `openSpritesProxyTunnel({spriteName, port: 8787})`, writes
   `ping`, expects `ping` back, and prints round-trip time. Then waits 60s
   with the tunnel idle, writes again, and reports whether the tunnel still
   works or which error it raised.
4. S1: closes the tunnel, waits 90s, calls `getSprite` and prints the status
   (expect `cold`). Re-dials the tunnel and prints cold-wake latency. Execs
   `pgrep -f createServer` to report whether the service process survived
   hibernation.
5. S3 timing: measures `checkpoint()` and `restoreCheckpoint()` durations on
   the fresh sprite.
6. Deletes the sprite in a `finally`. Never leaves a spike sprite behind.
7. Prints a summary table at the end, one row per spike item, with
   `PASS`/`FAIL`/`INFO`.

Add an npm script `spike:sprites`. Add a "Phase 0 findings" section stub to
`docs/sprites-migration-design.md` with the columns the script prints, so the
operator pastes results there. Change the doc status line from
"no implementation yet" to "Phase 1–3 landed; Phase 0 findings pending".

Run typecheck only. Do not run the script.

---

## Prompt 8 — Phase A bootstrap (the worker bundle must exist inside the sprite)

Context: `SpritesRunnerProvider.create()` in `lib/runner/sprites.ts` defines
the worker service as `node dist/run-worker.js` in `/home/user`. Nothing
installs that bundle. The service crash-loops on `MODULE_NOT_FOUND`. Design
§6 Phase A and Phase 4 describe the fix. The standalone bundle builder is
`scripts/build-worker-standalone.mjs`; look at `lib/runner/worker-sha.ts` for
how the worker SHA is computed, and at git history (`git log -S ensureTemplate`)
for the removed Box template-build flow with per-step progress events.

Task:

1. Add config `config.sprites.workerBundleUrl`
   (`TASK_ORCH_SPRITES_WORKER_BUNDLE_URL`, a URL template that may contain
   `{sha}`). Required when the provider is `sprites`; add a startup guard
   next to the existing `SPRITES_TOKEN` check and a line in `.env.example`.
2. Add `lib/runner/sprites-bootstrap.ts` exporting
   `bootstrapSprite(client, spriteName, opts: { workerSha, bundleUrl, onStep })`.
   Steps, each run through `client.exec` and reported via `onStep(name, status, durationMs)`:
   - `fetch-worker`: `mkdir -p /home/user/worker && curl -fsSL <url> | tar -xz -C /home/user/worker`
   - `verify-worker`: `test -f /home/user/worker/dist/run-worker.js`
   - `checkpoint`: `client.checkpoint(spriteName, "bootstrap <sha>")`
   Fail the whole bootstrap with a `SpritesBootstrapError` naming the step when
   any exec exits non-zero. Include the last 2KB of stderr.
   Skip the repo clone and `npm ci`: the worker does those itself per turn
   today (see `containerCheckoutAt` in the worker). Say so in a comment.
3. In `create()`, call `bootstrapSprite` after `createSprite` and before
   `putService`. Set `dir: "/home/user/worker"` on the service definition.
   Time it as `sprites_bootstrap`. Emit an agent event
   `runner_bootstrap_step` per step so the run view can show progress.
4. Make bootstrap idempotent: if `listCheckpoints` already contains one with
   comment `bootstrap <current sha>`, skip straight to the service definition.
   This covers the 409 "sprite already exists" path.
5. Tests in `__tests__/sprites-bootstrap.test.ts` with a fake client: happy
   path calls exec twice then checkpoint; a failing `verify-worker` raises
   `SpritesBootstrapError` with `step === "verify-worker"`; an existing
   matching checkpoint skips exec entirely.
6. Update `docs/runners/sprites.md` with a "Bootstrap" section: what is
   installed, where, how to publish the bundle tarball, and the env var.

Run typecheck and all `__tests__/sprites*.test.ts`.

---

## Prompt 9 — Close the channel at turn end so sprites hibernate

Context: design §3 "turn end (idle/parked)": an open proxy connection is
activity, so the control plane must close the channel WebSocket when a run
parks or goes idle, or the sprite bills forever. Find where the controller
side handles the run leaving the active states (search `lib/worker-channel/`
and `lib/runs.ts` for `parked`, `idle`, `releaseClaim`, and the connection
registry that maps run id → `ControllerConnection`).

Task:

1. Document, in a short comment at the registry, what currently happens to
   the socket when a Fly run parks. If it already closes, this prompt reduces
   to a test.
2. If it stays open: add a hook so that when a sprites-provider run enters
   `idle` or `parked` (or any terminal status), the controller closes the
   socket with a normal close code after the final frame is acknowledged.
   Reconnect on the next `dispatchRun` is already the resume path.
3. Add a test that drives a fake worker through `run.start` → park and
   asserts the controller socket receives `close` with the chosen code, for
   a `sprite://` endpoint only. Local and Fly behaviour stays as before.
4. Add a line to `docs/runners/sprites.md` under "Lifecycle".

Run typecheck and the worker-channel tests.
