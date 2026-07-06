# Narrow worker ingest API — design

**Date:** 2026-07-06
**Status:** Draft v2 (review changes incorporated 2026-07-06; awaiting approval — no Tier 2 code before then)
**Scope:** A small authenticated HTTP surface through which worker Machines
write run messages, events, and status transitions, so that `DATABASE_URL`
can eventually be removed from worker env. Heartbeats, claims, dispatch, and
all reads stay on the DB path (explicit non-goals).

> **v2 changelog** (design review, 2026-07-06 — direction approved, changes
> requested): owner-generation token replaces the narrow cancel/orphan-only
> epoch (Decision 1); shadow mode gets its own dedup table so it can never
> poison authoritative idempotency keys (Decisions 3, 7); an explicit
> tx-parametric refactor of the write helpers is now a plan prerequisite
> (Decision 2); batches are fail-fast (Decision 2); dedicated ingest secret
> with a dual-secret rotation window (Decision 1); op ids carry the durable
> generation (Decision 3); plus retention for `ingest_ops`, terminal-run
> append rejection, and shadow error isolation.

## Motivation

Two production incidents (2026-07-05/06) exposed the cost of "every process
writes the DB directly":

1. **Credential blast radius (the driver).** `buildFlyWorkerEnv`
   (`lib/runner/fly.ts:268`) passes the full `DATABASE_URL` into every worker
   Machine. The agent inside executes untrusted code — `npm install`, build
   scripts, arbitrary bash in cloned third-party repos — and incident run #58
   demonstrably ran repo build tooling as a subprocess of the worker. Anything
   that reads that env can read/modify the entire prod DB: every user's tasks,
   the `users` and `api_tokens` tables, everything. Tier 0 (env scrub for tool
   subprocesses, PR #91) shrinks the leak surface; only removing the credential
   from the Machine entirely removes the class.
2. **Non-atomic finalize** (fixed at the root by Tier 1's transactional
   finalize, PR #92; the ingest API additionally centralizes those writes in
   one process, where they are observable and retryable).
3. **Diagnosability.** Worker-side DB write failures are swallowed
   (`touchHeartbeat` call sites); "worker wedged" vs "worker's DB path broken"
   are indistinguishable from the server. An HTTP ingest path gives the server
   a per-run, per-op log of worker write traffic and its failures — including,
   post-v2, an explicit "stale-generation writer rejected" signal that today's
   DB path cannot produce at all.

## Decided direction (constraints this design honors)

The DB stays the coordination bus. Workers deliberately survive server
redeploys because they talk to Postgres, not the server (3 deploys happened
mid-incident and harmed nothing), and the dispatch machinery relies on
conditional-UPDATE-as-CAS that an HTTP API would just reimplement against the
same DB. **Non-goals:** moving heartbeats, claims, dispatch, or stream reads
behind an API; making the single web Machine a hard availability dependency
for in-flight turns. The "pending row is the dispatch request" contract
(PR #90, `deferRunForServerDispatch`) is untouched: workers still express
"dispatch this run" as a plain DB write; the ingest API is for *content*
writes (messages/events/status), never for control-plane actions.
`docs/nested-machine-dispatch.md` already names this shape as sanctioned
future work ("option B — a broker endpoint... strictly better on secrets...
additive on top of C, not a rewrite").

---

## Decision 1 — Token: HMAC-signed stateless token carrying a durable worker generation

**Format.** `tow1.<base64url(payload)>.<base64url(sig)>` where
`payload = JSON {v: 1, run: <runId>, gen: <int>, iat: <unix>}` and
`sig = HMAC-SHA256(payload, ingestSecret)`. The `tow1.` prefix mirrors the
existing `tot_` API-token convention (`lib/api-tokens.ts`) so tokens are
recognizable in logs and secret scanners.

**The generation (v2 — replaces v1's narrow "epoch").**
`agent_runs.worker_generation int not null default 0` is the durable
owner-generation of the run's currently-authorized worker. The token embeds
the generation current at mint time; the handler compares it to the row (which
it loads anyway for guards — no extra query). A mismatch is a 403 with a
distinct `stale_generation` error code.

Bump sites — the rule is *"a new writer exists, or no writer may exist"*:

1. **Every time a new Machine is provisioned for the run** —
   `FlyRunnerProvider.create()` and the cold-recover branch of `resume()` —
   the bump happens *before* `buildFlyWorkerEnv` mints, so the replacement
   worker carries the new generation and **every prior worker's token goes
   stale the moment its replacement exists**. This closes the zombie hole the
   v1 design accepted: after a resumable re-dispatch lands on a new Machine, a
   revived "dead" worker's message/event appends are *rejected at the route* —
   strictly stronger than today's DB path, where nothing distinguishes the two
   writers for content appends. (v1's "both tokens verify, same as the DB
   path" was rejected in review: content appends are not protected by status
   CAS/terminal guards, and the entire point of an ingest authority is that
   the server can cheaply enforce current ownership.)
2. **Terminal give-ups with no replacement:** `cancel()`; `close()` (a hard
   stop — sets `cancelRequested`, cascades cancellation to descendants; its
   outstanding workers must not write anymore); the genuine-orphan fail branch
   of `reconcileOrphanedRuns()`; and `handleWorkerDeath()`'s non-resumable
   failure paths (which call `setError`).
3. **Not bumped:** `startMachine` resume of the *same* Machine and plain
   suspend — the same worker comes back with its original env (PR #90's
   defer path relies on this), and its token must stay valid. Also not bumped
   on ordinary `completed`/`failed` landings: status writes are already
   guarded terminal-idempotent (Tier 1), and content appends to a
   terminal-status run are rejected by the route regardless of generation
   (Decision 2) — a generation bump would add nothing there. Route tests must
   pin this: a worker cannot append messages to a successfully completed run
   merely because its generation never changed.

**Why not the alternatives:**

- *DB-backed token row* (the `api_tokens` pattern): trivial revocation, but a
  bcrypt row per run adds a write to Machine creation, a lookup+compare to
  every ingest call, and a new lifecycle. The generation column gets
  revocation with one integer compare against a row the handler already loads.
- *JWT*: same cryptography as HMAC with more surface (header alg confusion,
  library dependency) and nothing we need (no third-party verifier, no
  audience). Rejected for the same reason `lib/api-tokens.ts` doesn't use JWTs.
- *Trust the 6PN private network*: unacceptable — the untrusted agent code
  runs *inside* the private network. The token must live only in the worker
  *process* env and *must be added to Tier 0's `SECRET_ENV_DENYLIST`* the
  moment it is introduced, so tool subprocesses never see it. (Worst case if
  it still leaks: the holder can append content to *its own run while it is
  that run's current worker generation* — the same authority the worker
  legitimately has — versus today's leak-the-whole-database. That asymmetry
  is the entire point of Tier 2.)

**Secret and rotation (v2).** A dedicated `TASK_ORCH_INGEST_SECRET` is
**required** for `shadow`/`on` modes — `fly-deploy.sh` stage 5 stages it. A
derivation fallback from `AUTH_SECRET` exists for local/dev only, with a
domain-separated info label (`task-orchestrator:worker-ingest-token:v1`) so an
ingest token can never be confused with, or derived equal to, any other
subsystem's material. Rationale for requiring the dedicated secret in
production: tokens have no expiry (below), so coupling their validity to
`AUTH_SECRET` means an auth-secret rotation silently invalidates every
outstanding worker's token. Rotation story: `TASK_ORCH_INGEST_SECRET_PREVIOUS`
is accepted as a secondary verification key during a rotation window that must
cover the maximum suspended-Machine age (7 days); mint always uses the primary.
If tokens are ever invalidated by rotation anyway, workers fall back to the DB
path (Decision 5) and the server logs the verification failures loudly — safe
during Tier 2's rollout, unacceptable in `strict`, which is another reason
`strict` is out of scope here.

**Minting.** At Machine-provisioning time inside `buildFlyWorkerEnv(runId)`:
`TASK_ORCH_INGEST_TOKEN: mintIngestToken(runId, currentGeneration)`. Minting
is a pure function of `(runId, gen, secret)` — no DB insert at machine-create
time. The generation bump (site 1 above) commits before mint reads it.
**Consistency rule (v2, resolving a v1 ambiguity):** the token is minted
whenever an ingest secret is configured, regardless of the mode flag —
`off` + secret ⇒ token present but unused; no secret ⇒ no token and the
effective mode is forced `off`. The rollout section and the plan use this
same rule.

**Lifetime.** No `exp` claim. Suspended Machines resume with their original
env, and the runner lifecycle keeps stopped Machines up to 7 days — an expiry
long enough to cover that is long enough to be useless, and a short one breaks
resume. Validity is bounded instead by run terminality (Decision 2's terminal
append rejection + Tier 1's terminal-status guards) and the generation check.

**Machine resume answer (open question 1).** Resume is a non-event: stateless
verification + no expiry + generation-not-bumped-on-resume means the original
env's token keeps working across suspend/resume cycles, exactly matching
PR #90's env-is-immutable reality. Only a *replacement* writer (or a hard
stop) invalidates it.

## Decision 2 — Endpoint shape: one batch route, `POST /api/ingest/runs/[id]`, fail-fast

A single route file `app/api/ingest/runs/[id]/route.ts`. Request:

```jsonc
POST /api/ingest/runs/42
Authorization: Bearer tow1.eyJ2IjoxLCJydW4iOjQyLCJnZW4iOjMsImlhdCI6MTc4NH0.…
{
  "ops": [
    { "opId": "42:3:7:0001", "kind": "message", "role": "agent", "content": "…" },
    { "opId": "42:3:7:0002", "kind": "event",   "type": "…", "payload": { } },
    { "opId": "42:3:7:0003", "kind": "status",  "status": "completed",
      "patch": { "prUrl": "…", "result": { } } }
  ]
}
→ 200 { "results": [ {"opId":"42:3:7:0001","ok":true,"id":9871},
                     {"opId":"42:3:7:0002","ok":false,"error":"…"},
                     {"opId":"42:3:7:0003","skipped":true} ] }
```

- **Batch, ordered, fail-fast (v2).** Ops apply sequentially. The first
  non-idempotent failure stops the batch: the response reports the applied
  prefix, the failing op's error, and every later op as `skipped` (not
  attempted). The worker then routes the failed op and the skipped suffix to
  the DB fallback *in order* (Decision 5). Rationale (review point 4): per-op
  continue can corrupt run semantics — e.g. a failed final message op followed
  by a succeeded status op lands a run `completed` with its final assistant
  message missing. A replayed op answered from the dedup table counts as
  success, not failure. (A future carve-out for explicitly independent
  telemetry ops is possible; v1 ships strict fail-fast only.)
- **Why one generic route, not typed routes:** the middleware session-auth
  gate (`middleware.ts`) needs exactly one new exemption prefix
  (`/api/ingest`), following the `/api/mcp` precedent (exempt from the session
  cookie gate, does its own Bearer verification). Typed sub-routes would
  triple the exempt surface for zero validation benefit — the `kind`
  discriminator is a zod union, validated as strictly as separate routes
  would be.
- **Path/token binding:** the `[id]` in the path must equal the token's `run`
  claim; mismatch → 403 before any parsing of `ops`. Then the generation
  check (Decision 1). Per-run scoping is enforced by the *route*, not by
  trusting op payloads.
- **Handlers reuse `lib/runs.ts` — via a tx-parametric refactor (v2).**
  Review point 3 identified a real conflict in v1: handlers must delegate to
  the existing write functions *and* each op's effect must share a transaction
  with its idempotency row — but `applyStatusTx` opens its own transaction
  internally, and `persistMessage`/the event helpers write through the
  module-level `db`. The plan therefore contains an explicit prerequisite
  refactor: split the low-level cores out so they accept a `tx`
  (`persistMessageCore(tx, …)`, `insertEventCore(tx, …)`,
  `applyStatusCore(tx, …)`), with the existing exported functions becoming
  thin wrappers that open their own transaction (DB-path behavior unchanged,
  existing suites stay green). The ingest handler opens one transaction per
  op, calls the same core the DB path calls, and inserts the `ingest_ops` row
  in it. This is a blocker-level requirement: without it the implementer
  either violates idempotency atomicity or forks the logic.
- **`status` ops carry an allowlisted `patch`** of the companion columns the
  worker writes with a transition today (`error`, `completedAt`, `result`,
  `prUrl`, `branch`, `sdkSessionId`, `parkReason`, `pendingQuestion`).
  Anything outside the allowlist is rejected. Notably absent: `workerScope`,
  `workerPid`, `heartbeatAt`, `status: "pending"` (dispatch parking stays a
  DB write under the PR #90 contract).
- **Terminal-run append rejection (v2).** `message`/`event` ops against a run
  whose status is already terminal are rejected (`run_terminal` error). The
  dedup lookup runs *first*, so replaying a batch whose message legitimately
  landed just before its status op completed the run still returns success
  for both. This — not a generation bump — is why ordinary `completed`
  landings don't need revocation (Decision 1, bump site 3).

**Coexistence with session auth (open question 2):** `middleware.ts` adds
`/api/ingest` to the bypass list next to `/api/mcp`; the route handler does
Bearer verification itself. No interaction with NextAuth.

## Decision 3 — Idempotency keys, DB-backed, generation-scoped

New table:

```
ingest_ops (
  run_id     int  not null references agent_runs(id) on delete cascade,
  op_id      text not null,
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, op_id)
)
```

Each op's effect and its `INSERT INTO ingest_ops` happen in the **same
transaction** (via the tx-parametric cores, Decision 2). On `(run_id, op_id)`
conflict the op is not reapplied; the stored `result` is returned. This makes
worker retries across server redeploys exact-once in effect.

**Op id scheme (v2 — review point 6).** `opId =
"<runId>:<gen>:<turnOrdinal>:<seq>"`, where `gen` is the durable worker
generation from the token and `turnOrdinal`/`seq` are the worker's in-process
counters *within that generation*. v1's `run:turn:seq` was rejected because
"turn" alone is in-process state: a crash → re-dispatch could regenerate the
same turn with different content under colliding keys, and dedup would then
suppress or mix the two attempts' legitimate writes. With the generation in
the key, a replacement worker can never collide with its predecessor —
its keys live in a fresh `gen` namespace — while a *restart of the same
Machine* (same generation, deterministic replay of the same buffered batch)
still dedups correctly. The existing `attempt` column is deliberately not
reused: it is a rework generation for terminal-but-resumable runs, not a
worker-claim generation.

**Shadow isolation (v2 — review point 2).** Shadow-mode requests never touch
`ingest_ops`. v1's "verify + dedup-log + discard effects" was a trap: a
shadow request writing authoritative dedup rows without applying effects
would make a later non-shadow replay of the same `opId` read as
already-applied — silently dropping a real write under version skew or a
mid-run mode flip. Shadow dedup is exercised against a separate
`ingest_shadow_ops` table (same shape, aggressively pruned) so the dedup code
path is still tested under real traffic without ever poisoning real keys.

**Retention (v2 — review feedback).** `ingest_ops` grows by one row per
migrated write. Cleanup is two-layered: `on delete cascade` ties rows to run
deletion, and the existing runner-lifecycle sweep gains a pruning step that
deletes `ingest_ops`/`ingest_shadow_ops` rows for runs terminal longer than a
retention window (default 30 days, env-tunable; shadow rows 7 days). Late
replay after pruning is not a correctness risk: a pruned op could only replay
that late via a worker outliving the 7-day Machine lifecycle, which cannot
happen; belt-and-suspenders, the terminal-run append rejection and terminal
status guards make a hypothetical replay a no-op anyway.

## Decision 4 — Which writes migrate (open question 3)

**Migrate behind the API (v1 scope):**

| Write | Today | Why it moves |
|---|---|---|
| `agent_messages` appends | `persistMessage` direct INSERT | Content write; highest volume of the sensitive class |
| `agent_events` appends (status mirrors, `runner_deferred`, child lifecycle, etc. — every worker-side `emit*`) | direct INSERT | Content write; same |
| Status transitions + companion column patch | one tx (Tier 1) | The incident-1 write; centralizing it in the server process makes every finalize observable |

**Stay on the DB path (justified):**

| Write/read | Justification |
|---|---|
| Heartbeats (`touchHeartbeat`, 20s cadence) | Pure liveness; moving them makes the single web Machine a hard dependency for lease liveness — during a deploy every worker's lease would age toward `HEARTBEAT_STALE_MS` in lockstep. Explicit non-goal. |
| Claim/release CAS, `deferRunForServerDispatch` | Conditional-UPDATE-as-CAS is the dispatch machinery; the API would reimplement the same statements with a network hop in the middle. Explicit non-goal (PR #90 contract). |
| All reads (run row, message context, `readStreamSince`, `run_input` LISTEN) | Readers don't move — explicit non-goal. |
| Worker log flusher (`worker-log-store`) | Bulky, chunked, self-healing, low sensitivity; migrating it buys little risk reduction. Candidate for a later phase, noted, not v1. |

**Consequence stated honestly (and named precisely, per review):** this tier's
milestone is *"remove sensitive content writes from worker DB authority"*, not
*"remove the worker DB credential"*. Because heartbeats, claims, and reads
stay on the DB path, **Tier 2 alone does not allow dropping `DATABASE_URL`
from worker env.** The final credential step (separate, later design) needs
one of: (a) moving the residual worker DB traffic behind the API once it has
an availability story, or (b) replacing the worker's `DATABASE_URL` with a
narrowly-privileged Postgres role (per-run row-level security on the handful
of remaining tables).

**End-state recommendation (v2 review): Option B — scoped role + RLS.**
Two reasons beyond taste. *Latency:* the residual traffic is the fast path —
context reads, stream tailing, 20s heartbeats — where a persistent TCP
Postgres connection beats an HTTP round-trip per operation; funneling it
through the single web Machine would also re-create the availability coupling
this design spends Decision 5 avoiding. *Capability:* the worker's `run_input`
wake-up is LISTEN/NOTIFY — it needs a persistent Postgres session (the reason
`docs/fly-deployment.md` mandates the session pooler) and cannot move to plain
request/response HTTP at all. Option B keeps workers close to the metal
without exposing the vault. The end-state design must be honest about what
RLS requires to be a real boundary, though: a shared role plus a settable
session variable (`SET app.run_id = …`) is *not* one — the untrusted code
holding the credential can simply SET a different run id. It takes a per-run
identity (e.g. `CREATE ROLE run_<id>_gen_<n> LOGIN` minted at provisioning,
policies keyed on `current_user`, dropped on revocation — which also gives
Option B a revocation story equivalent to the generation bump), with the
operational surface that implies (role lifecycle, session-pooler
compatibility, cleanup). That design is out of scope here; this tier's ingest
API remains the right first step regardless — it removes the high-value
content writes now, and its generation check, idempotency ledger, and
server-side write observability are things RLS alone does not provide.

## Decision 5 — Failure semantics (open question 4)

Worker-side client policy, per op:

1. **Try API** with short retry (3 attempts, 0.5s/1s/2s backoff, 10s budget).
   The server deploy window (single Machine, rolling restart) is seconds; this
   absorbs it invisibly.
2. **Fall back to the DB path** (the exact code that runs today) when the API
   stays down and `TASK_ORCH_INGEST=on` (not `strict`). On a fail-fast batch
   response (Decision 2), the failed op and the `skipped` suffix go to the DB
   fallback in their original order. The worker holds `DATABASE_URL`
   throughout Tier 2's rollout, so fallback is free, preserves the "3 deploys
   mid-incident harmed nothing" property, and keeps ordering: ops are sent
   sequentially (awaited), so a fallback op N lands before op N+1 regardless
   of transport. A `stale_generation` 403 also latches the DB fallback for
   the process (the server has already decided this worker is superseded; its
   DB writes then contend under exactly today's semantics, and the rejection
   is logged server-side — new forensic signal).
3. **Buffering:** in-memory only, as a transport detail of the retry window
   (the batch being retried). No durable worker-side spool: with DB fallback
   available there is nothing to spool for, and the generation-scoped `opId`
   scheme makes replay of an uncertain batch safe.

**Crash during the retry window (v2, explicit per review):** if the Machine
OOMs/crashes mid-retry, the in-memory buffer is lost — which is exactly
today's crash behavior. The heartbeat lease goes stale, the reaper reclaims
(resumable → replacement worker at a *new generation*; non-resumable →
orphan-fail, which also bumps the generation), and Tier 1's atomic finalize
guarantees there is no half-written terminal state to mislabel. Deterministic
generation-scoped op ids mean any batch that *did* land before the crash
replays as pure dedup reads if the same Machine restarts.

Interaction with the heartbeat lease and the reaper: heartbeats stay on the DB
path, so an API outage does not age the lease — a worker stuck in API retry
keeps heartbeating and the reaper stays away. The failure matrix:

| API | Worker→DB | Outcome |
|---|---|---|
| down | up | Fallback writes via DB; nothing lost (today's behavior). |
| up | down | **The incident-1 scenario, improved:** content writes flow via API (server's own DB connection); only heartbeats suffer. If the DB outage outlasts `HEARTBEAT_STALE_MS` (5 min) the reaper may reclaim — but post-Tier-1 finalize is atomic and post-Tier-2 the reaper *sees* the completed status the API landed, so it no longer mislabels delivered runs. |
| down | down | Worker retries both; if >5 min, lease expires and the reaper reclaims. Late replay by the original worker is harmless: `opId` dedup + terminal guards + the generation check rejecting the superseded writer. |

`strict` mode (API-only, no DB fallback) exists in the flag from day one but
is a **post-`DATABASE_URL`-drop** posture. Under Decision 4's recommended
end-state (Option B, scoped role + RLS) it may never be flipped at all: the
worker keeps a narrowly-scoped DB credential for the residual fast-path
traffic, and the fallback for content writes simply narrows to that scoped
credential. `strict` only becomes relevant if the end-state design instead
chooses API-for-everything — which would additionally require heartbeats over
API, a lease long enough to ride out deploys, and the dedicated-secret
rotation window.

## Decision 6 — run_stream relaying is unaffected (open question 5)

`run_stream` is a NOTIFY channel fired by AFTER-INSERT **triggers** on
`agent_events` / `agent_messages` (migration 0001). Triggers fire regardless
of which process or connection performs the INSERT — verified against the
migration SQL; moving the INSERT from the worker's connection to the server's
connection changes nothing about what readers see. `readStreamSince` re-reads
durable rows by cursor; `relayRunStream` / `sendMessageToRun` tail exactly as
before. The one worker-side *listen* (`run_input`, waking a live chat worker
on new user messages) is a read-path concern and stays on the worker's DB
connection per Decision 4. No reader moves; no reader can tell the difference.

## Decision 7 — Rollout (env-flag gated, image-skew tolerant)

`TASK_ORCH_INGEST` = `off` (default) | `shadow` | `on` | `strict`, resolved
**server-side** and passed to workers pre-resolved via `buildFlyWorkerEnv`,
exactly like `TASK_ORCH_NESTED_DISPATCH` (workers can't compute server
defaults). Alongside it: `TASK_ORCH_INGEST_URL` (default
`http://${FLY_APP_NAME}.flycast` — 6PN-internal, fly-proxy routes to the web
service; overridable for local/docker) and `TASK_ORCH_INGEST_TOKEN`
(Decision 1; minted iff a secret is configured — no secret forces `off`).

- **`off`:** nothing changes; token minted when a secret is configured but
  unused; server route live but idle. Lets us stage server + image before any
  behavior change.
- **`shadow`:** worker writes via the DB path (authoritative) AND fires the
  same ops at the API with a `shadow: true` marker; the server verifies,
  dedups against `ingest_shadow_ops` only, logs validation/auth/shape
  results, and discards effects. **Isolation guarantees (v2):** shadow never
  writes `ingest_ops`; the worker-side shadow send is fire-and-forget and
  wrapped so any shadow-path bug can neither delay nor fail the authoritative
  DB write; the server-side shadow handler catches its own errors and returns
  a success-shaped response. Shadow is retained despite the extra table
  because this surface changes auth, shape validation, batching, and write
  transport at once — proving all four under real traffic before touching the
  authoritative path is worth the cost (review concurred).
- **`on`:** API is primary, DB path is automatic fallback (Decision 5).
- **`strict`:** future, post-`DATABASE_URL`-drop.

Version-skew matrix (workers bake code into the runner image; suspended
Machines can resume up to 7 days later with the *old* image and *old* env):

| Worker image | Server | Behavior |
|---|---|---|
| old (no client) | new | Worker ignores unknown env vars; DB path as today. Server route idle. ✅ |
| new | old (no route) | Client gets 404, falls back to DB path permanently for that run. ✅ |
| new, `off`/`shadow` | new | DB-authoritative. ✅ |
| new, `on` | new | API-primary with DB fallback. ✅ |

Rollout order: (1) ship server route + token minting (`off`), stage
`TASK_ORCH_INGEST_SECRET`; (2) rebuild runner image (`fly-deploy.sh` step 4 or
`runner-image-nightly.yml`); (3) flip `shadow`, watch the server-side ingest
log for a few days of real runs (including any `stale_generation` rejections —
those are zombies we've never been able to see before); (4) flip `on`; (5) DB
fallback stays supported until the separate final-step design lands — at
minimum 7 days past `on` (max suspended-Machine age) before even discussing
`strict`.

## Security summary

- Token scope: write-only, run-scoped, generation-scoped (current authorized
  worker only), content-only (no control-plane verbs, no reads, no other
  runs' ids accepted by the route).
- Token lives only in the worker process env; added to Tier 0's
  `SECRET_ENV_DENYLIST` so agent tool subprocesses never inherit it, and it is
  never echoed into logs (log the `run`/`gen` claims, never the sig).
- Exfiltrated-token blast radius: attacker can append content to the run they
  already control the agent of, only while that worker remains the run's
  current generation — no privilege beyond what prompt-injecting the agent
  already grants. Compare `DATABASE_URL`: full read/write of every table for
  every user. This asymmetry is the acceptance criterion for the whole tier.
- Ingest secret is dedicated (not shared with session auth), domain-separated
  in the dev fallback, and rotatable via a dual-secret verification window.
- The server route rate-limits per run (simple token bucket keyed by runId) so
  a misbehaving worker cannot amplify into the DB via the server.

## Diagnosability (incident 3, partial)

Every ingest failure is now a *server-side* log line with runId, opId, kind,
and error class — versus today's silently-swallowed worker-side write errors.
Stale-generation rejections surface zombie writers that are invisible today.
`touchHeartbeat`'s swallow itself is out of scope (heartbeats stay DB-path),
but "worker's write path broken" becomes visible the moment traffic shifts to
the API.

## Review disposition (v2)

| Review point | Disposition |
|---|---|
| 1. Epoch revocation too narrow | Adopted: owner-generation model, bumped on every replacement-Machine provisioning + cancel/close/worker-death/orphan-fail; validated per op (Decision 1). |
| 2. Shadow idempotency trap | Adopted: `ingest_shadow_ops`, authoritative table never written by shadow (Decisions 3, 7). |
| 3. Helpers vs same-tx conflict | Adopted: tx-parametric core refactor is an explicit blocker-level plan task (Decision 2). |
| 4. Batch failure semantics | Adopted: fail-fast with skipped-suffix reporting; client falls back in order (Decisions 2, 5). |
| 5. Secret rotation | Adopted: dedicated secret required for shadow/on; `_PREVIOUS` dual-verify window ≥7d; domain-separated dev derivation; off-mode minting rule made consistent (Decision 1, 7). |
| 6. opId needs durable generation | Adopted: `runId:gen:turn:seq` (Decision 3). |
| Gemini: `ingest_ops` bloat | Adopted: lifecycle-sweep pruning + cascade (Decision 3). |
| Gemini: derivation domain separation | Adopted (Decision 1). |
| Gemini: crash in retry window | Documented: self-heals via lease + Tier 1 + generation-scoped replay (Decision 5). |
| Gemini: why complete/fail don't bump | Documented + test-pinned via terminal-run append rejection (Decisions 1, 2). |
| Gemini: shadow must never block real path | Adopted (Decision 7). |

## Open items deliberately deferred

- `GH_TOKEN` removal from worker env (Tier 0 residual; askpass socket or
  root-owned credential file — separate design).
- Worker log flusher migration.
- The `DATABASE_URL` end-state design: recommendation recorded (Decision 4,
  Option B — per-run scoped Postgres role + RLS); the per-run role mechanics
  (minting, pooler compatibility, lifecycle) need their own spec.
- Heartbeat error surfacing (incident 3 root fix).
- Per-op-continue carve-out for independent telemetry ops (Decision 2).
