# Sprites runner integration

The **Sprites** provider runs each agent run in its own persistent, auto-hibernating
Sprite. Select it with `TASK_ORCH_RUNNER=sprites`. Use it when you want
per-run isolation with automatic hibernation — sprites bill only
while awake.

New here? Read [Workers and runners](README.md) first. This page assumes the
control-plane / worker split, the run lifecycle, and the worker channel.

Implementation: `lib/runner/sprites.ts` (the provider) and
`lib/runner/sprites-client.ts` (the Sprites REST client). Migration design:
[../sprites-migration-design.md](../sprites-migration-design.md).

---

## What Sprites is

Sprites are Fly's higher-level compute primitive: **persistent Linux VMs
(Firecracker) that hibernate automatically after ~30s of inactivity and wake
automatically on demand**, billed only for awake time plus storage. Each sprite
is a named environment with a persistent filesystem, a REST/WebSocket control
surface (`https://api.sprites.dev/v1`), copy-on-write checkpoints (~300ms), a
supervised-services API, per-sprite DNS network policy, and a TCP proxy.

Task Orchestrator's model: **one sprite per run**, named
`${TASK_ORCH_SPRITE_PREFIX:-to-run-}<runId>`. A run's sprite checks out the
repo, runs the agent session, pushes a branch, opens/updates a PR, then
hibernates when idle. The control plane **closes the channel at turn end** —
an open proxy connection counts as activity and would keep the sprite awake
and billing. Dialing a cold sprite wakes it transparently.

---

## Architecture

`SpritesRunnerProvider` (`lib/runner/sprites.ts`) implements the `RunnerProvider`
interface (`kind = "sprites"`). It's built with a `SpritesClient` — a thin typed
wrapper over the Sprites REST API (`lib/runner/sprites-client.ts`) with a bearer
token (`SPRITES_TOKEN`), a 30s request timeout, and errors surfaced as
`SpritesApiError`. The client covers sprites (`createSprite` / `getSprite` /
`deleteSprite` / `listSprites` with pagination), services (`getService` /
`putService` / `startService` / `stopService`), checkpoints, and network policy.

Liveness has no clock. `inspect(handle)` reads the sprite and its `worker`
service and answers `alive` (with incarnation `started_at#pid`), `dead`
(with the service's `error`), or `unknown`. At channel hello the controller
records the incarnation only when it matches the PID the worker reports;
`resolveLiveness(runId)` later compares the observed incarnation with the
stored one — a different one means the process was replaced. `unknown` never
authorises a destructive action. See `docs/plans/liveness-without-clocks.md`.

`buildSpritesWorkerEnv` builds each worker service's environment — same
allowlist as `buildFlyWorkerEnv` (GitHub token, agent credentials, model/backend
settings, `TASK_ORCH_INSIDE_WORKER=1`, channel identity, etc.) but no
`PREWARM_DIR`.

---

## Runner lifecycle & sequence

### Admission

The gate counts active `runner_instances` rows in states `creating`/`starting`/
`running` for provider `sprites` and defers when the count reaches
`TASK_ORCH_MAX_SPRITES` — counted as sprites whose worker the provider observes
`alive`, not sprite rows (idle chats keep a hibernated sprite). Setting it to `0`
disables the gate. A deferred run
parks in `pending`; the pump retries oldest-first. Unlike the local provider,
**Sprites admission never looks at memory** — capacity is a sprite count.

### Provisioning (`SpritesRunnerProvider.create`)

1. If a `runner_instances` row with a `spriteName` already exists → delegate to
   `resume`.
2. `POST /sprites` — name = `${prefix}${runId}`, `url_settings.auth = "sprite"`.
3. **Bootstrap** — `lib/runner/sprites-bootstrap.ts:bootstrapSprite` fetches the prebuilt worker bundle into `/home/user/worker` and checkpoints it. See Bootstrap below.
4. `PUT /sprites/{name}/services/worker` — `cmd: node`,
   `args: ["dist/run-worker.js", "<runId>"]`, `env: buildSpritesWorkerEnv`, `dir: /home/user/worker`.
5. `POST /sprites/{name}/services/worker/start`.
6. Optional: apply network policy from `TASK_ORCH_SPRITE_NET_ALLOW`.
7. Compute the channel dial endpoint — `sprite://<name>:8787` — and upsert the
   `runner_instances` row with `state: "starting"`, the sprite name, and the
   channel endpoint.
8. On any failure: best-effort `DELETE /sprites/{name}`, then rethrow.

### Boot + channel

The sprite's worker service runs `node dist/run-worker.js <RUN_ID>` and binds
the channel port `8787`. The control plane dials it **through the authenticated
TCP proxy**: `WSS api.sprites.dev/v1/sprites/{name}/proxy` with
`Authorization: Bearer $SPRITES_TOKEN`, handshake `{"host":"localhost","port":8787}`,
then `{"status":"connected"}` — from then on the socket is a raw TCP relay
wrapped as a `Duplex` and used as the transport for the ordinary
`/worker/channel` WebSocket handshake (WS-over-WS). See
`lib/runner/sprites-tunnel.ts` and `lib/worker-channel/connection.ts`.

Auto-wake: dialing a cold sprite wakes it; no explicit start call.

### Sweep

Every pump tick (`TASK_ORCH_PENDING_PUMP_MS`, default 15s) the sweep lists sprites by prefix
(paginating past the 50-item cap), reconciles each row's state
(`running→running`, `warm→starting`, `cold→suspended`, 404→`gone`), and
decides a lifecycle action. **Suspension is automatic** — sprites hibernate
themselves ~30s after activity ceases. The only decision left to us is
**destroy**: `nextSpritesLifecycleAction` → `destroy` once a terminal run is
past `TASK_ORCH_RUNNER_TERMINAL_MS` (default 24h), or an idle run past
`TASK_ORCH_RUNNER_STOP_MS` (default 7d); a provider-observed live worker is
never destroyed. A missing sprite → the row goes `gone` and, if the run was
still active, the death policy runs. The sweep also reaps leaked prefix-owned
sprites with no live row (after a grace window). A `cold` sprite with an active
run is **not** a death — hibernation mid-turn is not failure. A wedged-but-alive
worker is bounded only by the per-turn budget deadline.

### Lifecycle

Sprites hibernate automatically ~30 s after activity ceases. The control plane closes the channel `WebSocket` with code `1000` when a run enters `idle`, `parked`, or any terminal status (`completed`/`failed`/…), after the final frame is acked. An open proxy tunnel would otherwise count as activity and keep the sprite billing. Reconnect on the next `dispatchRun` re-dials the proxy and wakes a cold sprite.

### Hard cancel (`stop`)

`DELETE /sprites/{name}`, releases the claim, marks the row `gone`, clears the
SDK session token.

### Runner state machine

| Sprite status | RunnerState |
| --- | --- |
| `running` | `running` |
| `warm` / `starting` / `creating` | `starting` |
| `cold` / `hibernated` | `suspended` |
| `destroyed` / `destroying` / `gone` | `gone` |
| other / unknown | `starting` (conservative) |

---

## What the worker gets — and deliberately doesn't

`buildSpritesWorkerEnv` includes: the GitHub token, the agent credentials
(Claude auth + pi provider keys), model/backend settings,
`TASK_ORCH_INSIDE_WORKER=1`, `SESSION_ROOT=/home/user/session`, the repo
cache dir, the *resolved* nested-dispatch policy, and the per-run channel
identity.

It **deliberately omits**:

- **`DATABASE_URL`** — WebSocket-only; workers never touch Postgres.
- **`SPRITES_TOKEN` / `TASK_ORCH_RUNNER`** — workers cannot reach the Sprites
  API. The token is org-scoped (can create/destroy any sprite) and is never
  handed out. `api.sprites.dev` can also be blocked via network policy inside
  the sprite, making the no-token rule structural.

---

## Bootstrap

The standard base image (Ubuntu + Node 22, Python 3.13, Claude Code) has **no
bring-your-own-Docker-image**. The worker bundle is installed into the sprite at runtime
via `lib/runner/sprites-bootstrap.ts`.

**What is installed and where:**
- The prebuilt worker bundle is fetched from `TASK_ORCH_SPRITES_WORKER_BUNDLE_URL` (default: `${TASK_ORCH_PUBLIC_URL}/api/worker-bundle`) and extracted to `/home/user/worker`. The tarball is produced by `npm run build:worker:standalone` (`scripts/build-worker-standalone.mjs`) and contains `dist/run-worker.js` plus its `node_modules`.
- The worker service is then defined with `dir: /home/user/worker` and `cmd: node dist/run-worker.js <runId>`.
- No `git clone` and no `npm ci` are done in the sprite during bootstrap; the worker does its own blobless checkout per turn via `containerCheckoutAt`. This keeps bootstrap to a single `curl | tar` plus a `test -f` and a checkpoint.

**How the bundle is served (default):** the control plane image ships
`dist/run-worker.standalone.js` (Dockerfile.server). The unauthenticated route
`GET /api/worker-bundle` packs it as `dist/run-worker.js` on the fly. With
`TASK_ORCH_PUBLIC_URL` set, no bundle URL config is needed. The bootstrap
checkpoint is keyed by the bundle id (sha1 of the shipped file), so a deploy
with a new bundle re-bootstraps and a deploy with the same bundle skips. No
build arg or git sha is involved.

To serve the bundle from elsewhere, set `TASK_ORCH_SPRITES_WORKER_BUNDLE_URL`;
an optional `{sha}` placeholder expands to the bundle id.

**Alternative store:** tar `dist/run-worker.standalone.js` as `dist/run-worker.js`
(`worker-<sha>.tar.gz`), upload to a GitHub release asset or R2/S3, and point the
URL template there.

**Idempotency:** Bootstrap checks `listCheckpoints` for an existing checkpoint with comment `bootstrap <sha>` and skips `fetch-worker`/`verify-worker`/`checkpoint` entirely when found. This covers the `409` sprite-already-exists path.

### Cold start & checkpoints

- **Phase A (correctness first):** `create()` runs the bootstrap above, then `POST /sprites/{name}/checkpoint` with comment `bootstrap <sha>`. Emits `runner_bootstrap_step` agent events per step for the run view.
- **Phase B (latency):** warm pool of pre-bootstrapped sprites (not yet implemented) — see `docs/sprites-migration-design.md` §6.

Checkpoints beyond warm boot (pre-turn rollback points, failure archiving) are Phase 8 — optional and not in the migration's critical path.

---

## Network policy (phased hardening, Phase 6 — not yet enforced)

1. Observe — no policy (Fly parity).
2. Allowlist, log-only.
3. Default-deny with `TASK_ORCH_SPRITE_NET_ALLOW` escape hatch.

Policy application lands in `create()` after sprite creation, before the worker
service starts.

---

## Key environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TASK_ORCH_RUNNER=sprites` | — | Select the provider |
| `SPRITES_TOKEN` | — | Org API token (control plane only). Required. |
| `TASK_ORCH_SPRITES_BASE_URL` | `https://api.sprites.dev/v1` | API endpoint |
| `TASK_ORCH_SPRITE_PREFIX` | `to-run-` | Run-sprite name prefix (sweep filter) |
| `TASK_ORCH_MAX_SPRITES` | `0` (gate off) | Max concurrent sprites |
| `TASK_ORCH_SPRITE_POOL_SIZE` | `0` (off) | Warm-pool target (phase 5) |
| `TASK_ORCH_SPRITE_NET_ALLOW` | — | Extra egress domains (phase 6) |
| `TASK_ORCH_SPRITES_WORKER_BUNDLE_URL` | `${TASK_ORCH_PUBLIC_URL}/api/worker-bundle` | Worker bundle URL; optional `{sha}` expands to the bundle id. |
| `TASK_ORCH_RUNNER_TERMINAL_MS` | `24h` | Retention before destroy |
| `TASK_ORCH_SPRITES_CLAUDE_BINARY` | `/home/sprite/.local/bin/claude` | Claude Code executable inside the sprite; passed to the worker as `TASK_ORCH_CLAUDE_BINARY` (the bundle has no native binary). |
| `TASK_ORCH_SPRITES_CODEX_BINARY` | `/home/user/worker/.codex/bin/codex` | Optional pre-provisioned Codex executable. When unset, bootstrap installs pinned `@openai/codex` 0.153.4 with optional platform dependencies. |

Credentials (`GH_TOKEN`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`,
optional pi provider keys) are staged as secrets on the control plane and
passed into each sprite's worker service env by `buildSpritesWorkerEnv`.

---

## Related

- [Workers and runners](README.md) — the overview
- [Migration design](../sprites-migration-design.md) — full phased plan
- [Worker WebSocket protocol](../worker-websocket-protocol.md)
