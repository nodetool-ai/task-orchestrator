# Fly Machines → Sprites migration: design and plan

**Status:** Phase 1–6 landed; Phase 0 findings pending (feasibility script not yet run), bootstrap (Prompt 8) and channel close (Prompt 9) pending
**Scope:** replace the Fly Machines runner provider (`TASK_ORCH_RUNNER=fly`)
with a Sprites-backed provider (`TASK_ORCH_RUNNER=sprites`), keeping the
control-plane / worker architecture unchanged.

Primary sources: the [Sprites API reference](https://sprites.dev/api)
(sprites, [exec](https://sprites.dev/api/sprites/exec),
[checkpoints](https://sprites.dev/api/sprites/checkpoints),
[services](https://sprites.dev/api/sprites/services),
[policies](https://sprites.dev/api/sprites/policies),
[proxy](https://sprites.dev/api/sprites/proxy),
[filesystem](https://sprites.dev/api/sprites/filesystem)), and this repo's
[runner architecture](runners/README.md) and
[Fly integration](runners/fly.md) docs.
(The Box integration this doc originally cited as precedent has since been
removed from the codebase; references to it below describe patterns from git
history, not live code.)

---

## 1. Why migrate

Sprites are Fly's higher-level compute primitive: **persistent Linux VMs
(Firecracker) that hibernate automatically after ~30s of inactivity and wake
automatically on demand**, billed only for CPU-hours / RAM-hours actually
awake plus GB-hours of storage. Each sprite is a named, isolated environment
with a persistent filesystem, a REST/WebSocket control surface
(`https://api.sprites.dev/v1`), copy-on-write checkpoints (~300ms), a
supervised-services API, per-sprite DNS-based network policy, and a TCP proxy
into the sprite.

That is almost exactly the machine Task Orchestrator hand-builds today out of
lower-level Fly parts. The Fly provider (`lib/runner/fly.ts`, ~1,000 lines) is
dominated by machinery that Sprites makes redundant:

| Fly provider machinery today | Why it exists | Under Sprites |
| --- | --- | --- |
| Volume create/fork/destroy, `vol_run_*` naming | Machines are ephemeral; state needs a separate volume | Gone — the sprite filesystem *is* the persistent state |
| Orphan-volume reaper (`reapOrphanVolumes`, grace windows, `pending_destroy` guards) | create() is non-atomic across volume+machine; crashes leak volumes | Gone — one object per run; `DELETE /sprites/{name}` reclaims everything |
| Idle lifecycle sweep deciding suspend/stop (`applyLifecycle`) | Someone must notice idleness and suspend the Machine | Mostly gone — sprites hibernate themselves after ~30s idle; we only decide *destroy* |
| Wake-window race machinery (`wakeRequestedAt`, run-139 incident) | Our own sweep could suspend a Machine we just woke, before its first heartbeat | Gone with the suspend path — we never suspend; Sprites wakes transparently on connect |
| `startMachineWithRetry` on 409s, cold-recover from volume (run-135 incident) | Explicit start of a suspended Machine can fail; corpse vs. volume | Gone — there is no explicit start call; dialing a cold sprite wakes it |
| Prewarm seed volume + fork (`scripts/seed-prewarm-volume.ts`) | Baked `npm ci` blew past Fly's 8GB image cap; volume forks dodge it | Replaced by checkpoints / a warm pool (§6) |
| Shared-CPU memory-ratio validation (`assertValidSharedMachineResources`) | Fly rejects bad cpu/mem pairings opaquely | Gone — sprites have a standard shape (~8GB RAM / 8 vCPU); optional `policy/resources` caps |
| Private-IP resolution + 6PN-only dialing | The channel must never be public | Replaced by the authenticated TCP proxy (§5) — still never public |

There are also two new capabilities we don't have today:

- **Per-run network policy** — DNS allow/deny rules per sprite
  (`POST /sprites/{name}/policy/network`). Today a Fly runner Machine has
  unrestricted egress. This is a material security upgrade for a VM that runs
  untrusted agent-chosen shell commands.
- **Checkpoints** — ~300ms point-in-time filesystem snapshots with restore,
  usable before risky agent operations and as the warm-boot mechanism.

And a likely cost win: our runs spend most of their wall-clock **idle or
parked** between turns. Fly bills a started Machine whether or not it's doing
anything (which is why the sweep exists); Sprites bills nothing while
hibernated except storage.

**What we give up:** the custom runner image. Sprites launch from a standard
base image (Ubuntu-family with Node 22, Python 3.13, common dev tools, and
Claude Code preinstalled) — there is no bring-your-own-Docker-image in the
API. Everything `Dockerfile.fly-runner` bakes in (worker bundle, apt packages,
repo cache) must instead be installed *into* the sprite at runtime and
preserved via the persistent filesystem / checkpoints. §6 is the mitigation
plan; this is the single biggest migration risk.

---

## 2. Sprites API — the parts we use

Base URL `https://api.sprites.dev/v1`, auth `Authorization: Bearer
$SPRITES_TOKEN` (org-scoped token). Official SDKs exist (Go, Node
`@fly/sprites`, Python, Elixir); we'll write our own thin client like
`fly-client.ts` to keep the dependency surface unchanged.

| Concern | Endpoint |
| --- | --- |
| Create / get / delete sprite | `POST /sprites` (`name`, `url_settings.auth: sprite\|public`), `GET /sprites/{name}`, `DELETE /sprites/{name}` |
| List (sweep) | `GET /sprites?prefix=…&max_results=1..50&continuation_token=…` — **paginated; the client must loop** |
| Status | `cold` (hibernated) / `warm` (waking) / `running` |
| Run a command | `WSS /sprites/{name}/exec?cmd=…` (binary-framed stdin/stdout/stderr/exit; sessions survive disconnect and are re-attachable with scrollback) or `POST /sprites/{name}/exec` for simple non-TTY cases |
| Supervised long-running process | `PUT /sprites/{name}/services/{svc}` (`cmd`, `args`, `env`, `dir`, `needs`, `http_port`) + `start`/`stop`/`restart`/`logs` — streaming NDJSON |
| Reach a port inside the sprite | `WSS /sprites/{name}/proxy` — JSON handshake `{host, port}`, then raw TCP relay |
| Checkpoint / restore | `POST /sprites/{name}/checkpoint`, `GET …/checkpoints`, `POST …/checkpoints/{id}/restore` (restore stops services, rolls the filesystem back, restarts) |
| Network policy | `GET/POST /sprites/{name}/policy/network` — domain allow/deny rules, wildcards, presets; applies immediately |
| Resource caps | `GET/POST/DELETE /sprites/{name}/policy/resources` (memory limits) |
| Files without a shell | `GET/PUT /sprites/{name}/fs/read|write|list|…` |

Key behavioral facts the design leans on:

- **Auto-hibernate ≈30s after activity ceases; auto-wake on any inbound
  interaction** (exec, proxy, URL). Billing stops while cold.
- **Checkpoints are per-sprite.** The public API creates sprites only from the
  standard base image — there is no documented "create sprite from another
  sprite's checkpoint" (no cross-sprite fork, unlike Box). §6 designs around
  this; §9 lists it as the top thing to re-confirm with Fly, since a
  fork-from-checkpoint primitive would collapse our warm-boot design into
  Box's template model.
- **Exec sessions persist across disconnects** (TTY sessions indefinitely;
  non-TTY default 10s, tunable via `max_run_after_disconnect`) and replay
  scrollback on re-attach.

---

## 3. Target architecture

Nothing about the control-plane / worker split changes. The
`RunnerProvider` interface (`lib/runner/provider.ts`) is implemented by a new
`SpritesRunnerProvider` (`kind = "sprites"`), selected with
`TASK_ORCH_RUNNER=sprites`. One sprite per run, one `runner_instances` row per
run, worker channel semantics identical.

```
   ┌────────────────────────────┐        api.sprites.dev/v1 (bearer token)
   │        CONTROL PLANE       │──────────────────────────────────────────┐
   │  Postgres · dispatch · UI  │                                          │
   │  holds SPRITES_TOKEN       │   WSS /sprites/to-run-42/proxy           ▼
   └──────────────┬─────────────┘   {host:"localhost", port:8787}   ┌─────────────┐
                  │ worker channel (WS over the proxy's raw relay)  │  SPRITE      │
                  └────────────────────────────────────────────────►│ "to-run-42"  │
                                                                    │ worker svc   │
                                                                    │ :8787 listener│
                                                                    │ repo checkout │
                                                                    │ no DB creds,  │
                                                                    │ no SPRITES_   │
                                                                    │ TOKEN         │
                                                                    └─────────────┘
```

### Concept mapping

| Today (Fly) | Tomorrow (Sprites) |
| --- | --- |
| Machine + volume per run | One sprite per run, named `${TASK_ORCH_SPRITE_PREFIX:-to-run-}<runId>` — stable across turns (sprite names are unique per org; the prefix keeps multiple deployments from colliding and gives the sweep its `?prefix=` filter) |
| `FLY_RUNNER_IMAGE` (custom Docker image) | Standard base image + app-managed bootstrap + checkpoint (§6) |
| Machine env in `buildFlyMachineConfig` | `env` map on the worker **service** definition (`PUT …/services/worker`) |
| Entrypoint `fly-runner-entry.sh` → `node dist/run-worker.js` | Service `worker`: `cmd: node`, `args: [dist/run-worker.js, <runId>]` — supervised, restartable, logs via `GET …/services/worker/logs` |
| Channel dial `ws://[6PN-ipv6]:8787/worker/channel` | Channel dial through `WSS /sprites/{name}/proxy` → `localhost:8787` (§5) |
| `runner_instances.machineId` / `volumeId` | `runner_instances.spriteName` (new column; `machineId`/`volumeId` null). `channel_endpoint` stores a logical `sprite://<name>:8787` the dialer resolves |
| suspend / stop / start Machine | nothing — hibernation is automatic; dialing wakes |
| `machineStateToRunnerState` | `running→running`, `warm→starting`, `cold→suspended`, 404/missing→`gone` |
| Hard cancel: destroy Machine + volume | `DELETE /sprites/{name}` |
| `flyAdmit` counting Machines vs `TASK_ORCH_MAX_MACHINES` | identical count of active `runner_instances` rows vs `TASK_ORCH_MAX_SPRITES` |
| Prewarm seed volume fork | Warm pool of checkpointed sprites (§6, phase 2) |
| — (no equivalent) | Per-sprite network policy (§7) |
| — (no equivalent) | Pre-turn checkpoint for rollback (§8, optional) |

### Run lifecycle under Sprites

- **create():** create sprite → bootstrap (or claim from warm pool, §6) →
  define + start the `worker` service with the run's env → persist
  `runner_instances` (`provider: "sprites"`, `spriteName`, channel identity)
  → dial the channel → push `run.start`. On failure: best-effort
  `DELETE /sprites/{name}`, rethrow — no partial-object leak possible.
- **turn end (idle/parked):** control plane **closes the channel WebSocket**.
  This matters: an open proxy connection is "activity", so holding the channel
  open would keep the sprite billing forever. Once traffic stops, the sprite
  hibernates itself ~30s later. No suspend call, no sweep decision, no wake
  intent.
- **resume:** dial the proxy again. A cold sprite wakes automatically; the
  channel connects when the worker listener answers. The channel instance id /
  HMAC credential are reused exactly as today (the resume-identity rule is
  unchanged — the filesystem, SDK transcript, and checkout all survived in
  place). Whether the *worker process itself* survives hibernation is
  spike item S1 (§9): if processes survive (expected — Firecracker
  memory snapshot, same mechanism as Fly Machine suspend, and `sprite
  console -s` "gets you back where you were"), resume is a pure reconnect;
  if not, resume is `POST …/services/worker/start` first — the service
  definition persists either way, so both paths are one call.
- **destroy:** the only lifecycle decision left to us. `nextLifecycleAction`
  (`lib/runner/lifecycle.ts`) collapses to the retention question: a terminal
  run older than `TASK_ORCH_RUNNER_TERMINAL_MS` (default 24h, same knob) gets
  `DELETE /sprites/{name}`, the row goes `gone`, and `clearSdkSession` runs
  because the transcript died with the filesystem. Storage GB-hours are the
  only cost of generous retention, so the default can arguably lengthen.
- **sweep():** list sprites by prefix (paginating past the 50-item cap),
  reconcile row state, run death detection (row references a sprite the API
  404s on → `gone` → `handleWorkerDeath` if the run was active), apply the
  retention policy. The heartbeat reaper in `run-dispatch.ts` is unchanged and
  remains the backstop. One deliberate subtlety: a `cold` sprite with an
  active-status run is **not** a death — hibernation mid-turn just means the
  worker stopped doing anything; the stale-heartbeat reaper already covers the
  genuinely-hung case, and the sweep must not "helpfully" wake sprites (that
  would burn money and mask hangs).

### What stays exactly the same

Admission locking / atomic claim, the pending pump, `run.start` snapshot
semantics, tool.invoke over the channel, heartbeats, nested dispatch (a worker
still holds no provider credential, so child runs still park `pending` and the
control plane provisions their sprites), the `environments` registry pattern,
and the whole security posture of §4 of [runners/fly.md](runners/fly.md):
workers get **no `DATABASE_URL`, no `SPRITES_TOKEN`**.

---

## 4. Security model

- **`SPRITES_TOKEN` is control-plane-only**, exactly like `FLY_API_TOKEN`. It is org-scoped (can create/destroy/exec into *any* sprite
  in the org), so it must never appear in a sprite's env, service definition,
  filesystem, or logs. The worker service env is built by
  `buildSpritesWorkerEnv` mirroring `buildFlyWorkerEnv`'s explicit
  allowlist-and-omit structure.
- **The channel is authenticated twice**: the proxy hop requires the org
  bearer token (only the control plane has it), and the WebSocket handshake
  inside still presents the per-run HMAC credential
  (`TASK_ORCH_WORKER_CHANNEL_SECRET`-derived), so even a confused-deputy
  proxy connection can't drive a worker. `url_settings.auth` stays `sprite`
  (never `public`); we don't use the sprite URL at all in the baseline design.
- **Network policy as defense in depth (§7):** deny-by-default egress with an
  allowlist (github.com, api.anthropic.com, registry.npmjs.org, the pi
  provider endpoints actually configured) closes an exfiltration channel Fly
  runners have always had open. Notably it also lets us block
  `api.sprites.dev` *from inside the sprite*, making the no-token rule
  structural rather than merely hygienic.
- **Secrets in transit:** worker env (GH token, agent credentials) now flows
  through the Sprites API (service definition) rather than a Machine-create
  body — same trust in Fly either way.

---

## 5. The worker channel over the TCP proxy

The one genuinely new piece of plumbing. Today `flyChannelDialEndpoint`
produces `ws://[ipv6]:8787/worker/channel` and the generic WS client dials it.
Sprites has no control-plane-reachable private network, but it has exactly
what the removed Box integration taught us to want: an authenticated tunnel
to a port inside the runner (Box used the ascii.dev `host` proxy; Sprites'
is first-party).

Mechanism: open `WSS api.sprites.dev/v1/sprites/{name}/proxy` with the bearer
token, send `{"host":"localhost","port":8787}`, receive
`{"status":"connected"}`, and from then on the socket is a raw TCP relay.
We wrap that relay as a Node `Duplex` stream and hand it to the `ws` client
as the transport for the ordinary `/worker/channel` WebSocket handshake —
WS-over-WS, with the inner protocol byte-identical to today's. Implementation
is a small `spritesProxyStream(name, port)` helper in the client plus a
scheme-dispatch in the channel dialer (`ws+unix://` already set the precedent
for provider-specific dialing; this adds `sprite://<name>:<port>`).

Fallback if WS-over-WS proves awkward in practice (spike S2): define the
worker service with `http_port: 8787` and dial the sprite's authenticated URL
directly — fewer moving parts, but it routes the channel through the sprite's
public-ish URL surface and couples us to `url_settings` auth semantics, so
the proxy is Plan A.

Auto-wake makes this strictly simpler than Fly: "dial the endpoint" is also
"ensure the runner is awake", removing the start-then-dial two-step and its
409/wake-race error surface.

---

## 6. Cold start: bootstrap, checkpoints, and the warm pool

The hard problem. Today's warm boot comes from a custom image (apt packages,
worker bundle, repo mirror cache) plus a forked prewarm volume (baked nodetool
`npm ci`). Sprites offer neither custom images nor (per current docs)
cross-sprite forks. Plan in two phases:

### Phase A (correctness first): bootstrap-per-run, checkpoint after

On `create()`, after `POST /sprites`, run a bootstrap script via exec:

1. Fetch the **prebuilt worker bundle** for the current worker SHA — we
   already produce a standalone bundle (`scripts/build-worker-standalone.mjs`);
   publish it as a per-SHA tarball the control
   plane can hand the sprite a URL for (GitHub release asset or R2). `node
   dist/run-worker.js` then needs no `npm ci` of task-orchestrator at all.
   The base image's Node 22 matches `Dockerfile.fly-runner`'s pin.
2. `git clone --filter=blob:none` the agent repo (no image-baked mirror to
   `--reference`; blobless clone keeps the transfer small).
3. `npm ci` in the agent repo — **the dominant cost** (multi-GB for
   nodetool; the reason the prewarm volume exists today).
4. Install any apt packages from `Dockerfile.fly-runner`'s list the base
   image lacks (audit in spike S3 — the base already carries git, node,
   python, Claude Code; likely deltas are ffmpeg/poppler/pandoc-class tools).
5. **Checkpoint** (`POST …/checkpoint`, comment `bootstrap <worker-sha>`) so
   this sprite never pays bootstrap again, and record readiness.

This is the removed Box integration's template-build flow (steps, per-step
progress events, `pending_reason` while building) resurrected from git
history, but per-run rather than once, which is why Phase A alone isn't the
end state. Acceptable for correctness/rollout validation; first-turn latency
will be minutes.

### Phase B (latency): the warm pool

Because checkpoints don't cross sprites, we invert the template model: instead
of one template forked many times, keep **N pre-bootstrapped sprites** and
bind them to runs on demand.

- A pool manager (control-plane background loop, like the pending pump) keeps
  up to `TASK_ORCH_SPRITE_POOL_SIZE` sprites named `${prefix}pool-<n>` in
  state *ready*: bootstrapped for the current worker SHA, baseline
  checkpointed, hibernated (costing storage only).
- `create()` claims a ready pool sprite (atomic DB claim on a `sprite_pool`
  table: `sprite_name, worker_sha, state ready|claimed|refreshing, run_id`),
  **restores its baseline checkpoint** (~seconds; guarantees a clean slate—
  restore rolls back the whole writable overlay, wiping any residue by
  construction), starts the worker service with the run's env, and proceeds.
  Empty pool → fall back to Phase A bootstrap inline (`defer` + pending
  reason "Warming sprite…" beyond a threshold), and the pool refills in the
  background.
- The sprite is **bound to the run for the run's whole resumable life** —
  idle/parked runs keep their sprite (its filesystem holds the checkout,
  unpushed work, SDK transcript). Only terminal-retention expiry or hard
  cancel releases it, and released sprites are *destroyed*, not returned to
  the pool (never reuse a filesystem an untrusted agent wrote to for a
  different run — the baseline restore protects against accident, destruction
  protects against checkpoint-mechanism bugs; sprites are cheap to recreate
  in the background).
- Worker-SHA drift: pool entries record their SHA; a deploy with a new SHA
  marks old entries `refreshing` and the manager rebuilds them (drain, don't
  strand in-flight runs — same superseding semantics as `environments`).
- The per-run repo cache freshness story is unchanged: every turn still
  `git fetch`es, so a stale pool checkout is a seed, not a source of truth.

**If Fly ships create-from-checkpoint / cross-sprite fork** (spike S1 asks),
Phase B collapses to a template model — one golden sprite per worker SHA in the
`environments` table, forked per run — and the pool manager shrinks to a
cache-warmer. The `sprite_pool` schema should be designed so this is a
simplification, not a migration.

---

## 7. Network policy (new, phased hardening)

Rolled out separately from the provider swap so policy failures are never
confounded with migration failures:

1. **Observe** — ship with no policy (Fly parity).
2. **Allowlist, log-only intent** — apply a generous allowlist assembled from
   config: VCS hosts (github.com, *.githubusercontent.com), the agent
   backends in `agentCredentialEnv` (api.anthropic.com + configured pi
   providers), package registries (registry.npmjs.org, pypi.org,
   files.pythonhosted.org), and a preset bundle if Sprites' `include`
   presets cover "common dev". Watch for breakage on canary runs.
3. **Default-deny** — flip the tail rule to deny, add
   `TASK_ORCH_SPRITE_NET_ALLOW` (comma-separated extra domains) for
   per-deployment escape hatches. Policy application lands in `create()`
   after sprite creation, before the worker service starts; policy changes
   apply immediately per the API docs, so tightening mid-run is possible but
   not planned.

---

## 8. Checkpoints beyond warm boot (optional, later)

Cheap (~300ms, copy-on-write, non-disruptive) checkpoints enable two features
Fly volumes never could; both are explicitly out of the migration's critical
path:

- **Pre-turn rollback points** — checkpoint at each turn boundary; a
  destructive agent misstep becomes `restore` + re-dispatch instead of a
  dead run. (Restore restarts services, so it composes with the resume path.)
- **Debugging artifacts** — checkpoint a failed run's filesystem before
  retention destroys it (`TASK_ORCH_ARCHIVE_R2`'s "future in-runner archiver"
  intent from `fly.ts`, but native). Note the last-5-mounted /
  retention behavior of checkpoints needs confirming (spike S4) before
  promising anything here.

---

## 9. Spike checklist (Phase 0 gates)

Facts the design assumes that must be verified against the live API before
implementation proceeds — each maps to a design decision above:

- **S1 — hibernation semantics & fork.** Do processes (our worker, its WS
  listener, exec sessions) survive hibernate→wake with memory intact?
  (Expected yes; determines whether resume is reconnect-only or
  service-start-first — both designed for in §3.) And: is there any
  supported create-sprite-from-checkpoint / fork? (Determines Phase B shape,
  §6.)
- **S2 — proxy tunneling.** WS-over-the-TCP-proxy from Node: handshake,
  backpressure, wake-from-cold latency on dial, behavior when the sprite
  hibernates with the tunnel open (does the tunnel die or wedge? we *close*
  channels at turn end regardless, but the failure mode informs reconnect
  logic). Measure cold-wake→channel-connected time; the design bets on
  seconds.
- **S3 — base image audit.** Diff the base image against
  `Dockerfile.fly-runner`'s package list; measure Phase A bootstrap
  end-to-end (worker tarball + blobless clone + `npm ci` + apt delta) and
  checkpoint/restore times at our filesystem sizes.
- **S4 — operational limits.** Org sprite quota and creation rate limits
  (pool sizing, admission defaults), max service-env payload size (our env
  block is large: credentials + channel identity), checkpoint count/retention
  per sprite, sprite name length/charset constraints vs. our prefix scheme,
  actual idle-detection semantics (what counts as "activity" — CPU? network?
  an open but silent TCP tunnel?).
- **S5 — failure surfaces.** API error shapes (for a `SpritesApiError`
  taxonomy mirroring `FlyApiError`), behavior of exec/services against a
  destroyed sprite, restore-while-running semantics.

A throwaway `scripts/sprites-feasibility.ts` (modeled on
`scripts/fly-channel-probe.ts`) exercises all
five and becomes the basis of the client's integration tests.

---

## 10. Implementation plan

Each phase lands independently behind `TASK_ORCH_RUNNER=sprites`; `fly`
remains fully functional and selectable throughout — rollback at any point is
an env-var flip, since providers are memoized per kind and share the
`runner_instances` table.

**Phase 0 — Spike (gates everything).** Run §9 against a real org.
Deliverable: findings appended to this doc; go/no-go on the proxy channel
design and Phase A latency budget.

**Phase 1 — Client + provider skeleton.**
`lib/runner/sprites-client.ts` (typed fetch wrapper: sprite CRUD with
pagination, exec-POST, services, checkpoint, policy, proxy-stream helper;
30s timeouts; `SpritesApiError`), `lib/runner/sprites.ts` implementing
`RunnerProvider` with create/stop/sweep/startMonitor against a stub channel,
`provider.ts` + `lib/config.ts` wiring for the `sprites` kind, migration
adding `runner_instances.sprite_name`. Unit tests mirror `fly.ts`'s pure
predicates (status mapping, retention eligibility).

**Phase 2 — Channel transport.** The `sprite://` dialer + proxy `Duplex`
wrapper in `lib/worker-channel/`; `buildSpritesWorkerEnv`;
worker-service definition and start; end-to-end: dispatch a real run to a
sprite, watch it open a PR. Reconnect-after-control-plane-restart from
`channel_endpoint`.

**Phase 3 — Full lifecycle.** Admission (`TASK_ORCH_MAX_SPRITES`), sweep +
death detection + retention destroy, resume for idle/parked runs (covering
both S1 outcomes), hard cancel, `clearSdkSession` on destroy, runner
telemetry (`timeRunnerPhase` names: `sprites_create`, `sprites_bootstrap`,
`sprites_channel_dial`, …), nested dispatch verified (child runs get their
own sprites via the pump).

**Phase 4 — Phase-A bootstrap productionized.** Per-SHA worker tarball
publishing in the deploy pipeline; bootstrap steps with per-step progress
events + pending-reason + run-view stepper (reviving the removed Box
integration's build-stepper UX from git history);
post-bootstrap checkpoint; `environments` rows (`provider='sprites'`,
keyed by worker SHA) so `/environments` shows sprite readiness.

**Phase 5 — Warm pool.** `sprite_pool` table + manager loop, claim/restore
path in `create()`, SHA-drift refresh, pool metrics on `/environments`.
Exit criterion: p50 dispatch→running under ~15s from a warm pool.

**Phase 6 — Network policy.** §7's three-step rollout, config surface, docs.

**Phase 7 — Rollout + decommission.** Canary: staging on `sprites` for a
week of real runs; then production flip with `fly` as the documented
rollback. After a stable period: delete `fly.ts`, `fly-client.ts`,
`Dockerfile.fly-runner`, `fly.runner.toml`, prewarm/repo-cache scripts and
their CI; simplify `lifecycle.ts` to the destroy-only policy; drop the
`suspend`-side wake-intent machinery; rewrite `docs/runners/fly.md` →
`docs/runners/sprites.md` and update the README comparison table (the
"Choosing an integration" row becomes Local / Sprites). The
`machineId`/`volumeId` columns stay for historical rows.

### New configuration surface

| Variable | Default | Purpose |
| --- | --- | --- |
| `TASK_ORCH_RUNNER=sprites` | — | Select the provider |
| `SPRITES_TOKEN` | — | Org API token (control plane only). Required. |
| `TASK_ORCH_SPRITES_BASE_URL` | `https://api.sprites.dev/v1` | API endpoint |
| `TASK_ORCH_SPRITE_PREFIX` | `to-run-` | Run-sprite name prefix (sweep filter; multi-deployment isolation) |
| `TASK_ORCH_MAX_SPRITES` | `0` (off) | Admission cap, replaces `TASK_ORCH_MAX_MACHINES` |
| `TASK_ORCH_SPRITE_POOL_SIZE` | `0` (off) | Warm-pool target (Phase 5) |
| `TASK_ORCH_SPRITE_NET_ALLOW` | — | Extra egress domains (Phase 6) |
| `TASK_ORCH_RUNNER_TERMINAL_MS` | 24h | Retention before destroy (unchanged knob) |

Retired with Fly: `FLY_API_TOKEN`, `TASK_ORCH_FLY_APP`, `FLY_RUNNER_IMAGE`,
`TASK_ORCH_FLY_REGION` (regions aren't exposed in the Sprites API),
`TASK_ORCH_FLY_CPUS` / `_MEMORY_MB` (standard shape; `policy/resources` if
capping is ever needed), `TASK_ORCH_RUNNER_VOLUME_GB`,
`TASK_ORCH_PREWARM_SEED_VOLUME`, `TASK_ORCH_FLY_POLL_MS` (→ a generic
`TASK_ORCH_SPRITES_POLL_MS` if the default doesn't fit).

### Phase 0 findings (run `npm run spike:sprites` with `SPRITES_TOKEN` set and paste below)

| Spike | Item | Result | Notes / Measurements |
|-------|------|--------|----------------------|
| S1 | Hibernation: worker process survives cold wake | PASS/FAIL/INFO | `pgrep` survives, cold status, wake latency |
| S1 | Fork from checkpoint available | PASS/FAIL/INFO | |
| S2 | Proxy tunnel handshake + echo RT | PASS/FAIL/INFO | RT ms |
| S2 | Idle 60 s tunnel still works | PASS/FAIL/INFO | error if any |
| S2 | Cold-wake latency | PASS/FAIL/INFO | ms |
| S3 | Base image: `node --version` etc | PASS/FAIL/INFO | delta vs Dockerfile.fly-runner |
| S3 | `which ffmpeg pandoc pdftotext rg jq` | PASS/FAIL/INFO | |
| S3 | `checkpoint` / `restoreCheckpoint` timings | PASS/FAIL/INFO | ms |
| S4 | Quota / rate limits | PASS/FAIL/INFO | |
| S5 | Error shapes | PASS/FAIL/INFO | |

---

## 11. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| No custom image → bootstrap latency/fragility | **High** | Phase A checkpoint-after-bootstrap; Phase B pool; prebuilt worker tarball removes the worker-side `npm ci` entirely; S3 measures before we commit |
| Undocumented hibernation edge (processes not preserved) | Medium | Resume path designed for both outcomes (§3); S1 verifies |
| WS-over-proxy fragility | Medium | S2 spike; sprite-URL `http_port` fallback (§5) |
| Org quota / rate limits below our concurrency | Medium | S4; admission cap; pool absorbs bursts |
| Sprites is new — API drift, regional availability, SLA | Medium | Keep `fly` selectable until Phase 7; thin client isolates drift |
| 30s hibernate during *slow model turns* (worker waiting on API) | Low | Activity from the worker's own outbound traffic + open channel keeps it awake mid-turn; the stale-heartbeat reaper backstops; S4 confirms what counts as activity |
| Cost model surprise (awake-hours during long turns ≥ Machine cost) | Low | Billing telemetry in Phase 3; the idle-heavy fleet profile strongly favors usage billing |

---

## 12. Open questions for Fly / future revisions

1. Cross-sprite fork or create-from-checkpoint — the single biggest
   simplifier if it exists or ships (§6).
2. Custom base images or an image-layering story on the roadmap?
3. Configurable idle timeout (30s is aggressive for our turn cadence — fine
   given auto-wake, but tunability would cut wake churn).
4. Region pinning / data locality controls (we currently pin `ams`; the
   Sprites API exposes no region).
5. Checkpoint retention guarantees (the "last 5 mounted" behavior) — affects
   §8's rollback feature more than the migration itself.
