# Narrow worker ingest API — design

**Date:** 2026-07-06
**Status:** Draft (awaiting human review — no Tier 2 code before approval)
**Scope:** A small authenticated HTTP surface through which worker Machines
write run messages, events, and status transitions, so that `DATABASE_URL`
can eventually be removed from worker env. Heartbeats, claims, dispatch, and
all reads stay on the DB path (explicit non-goals).

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
   subprocesses) shrinks the leak surface; only removing the credential from
   the Machine entirely removes the class.
2. **Non-atomic finalize** (fixed at the root by Tier 1's transactional
   finalize; the ingest API additionally centralizes those writes in one
   process, where they are observable and retryable).
3. **Diagnosability.** Worker-side DB write failures are swallowed
   (`touchHeartbeat` call sites); "worker wedged" vs "worker's DB path broken"
   are indistinguishable from the server. An HTTP ingest path gives the server
   a per-run, per-op log of worker write traffic and its failures.

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

## Decision 1 — Token: HMAC-signed stateless per-run token, with a DB-backed revocation epoch

**Format.** `tow1.<base64url(payload)>.<base64url(sig)>` where
`payload = JSON {v: 1, run: <runId>, epoch: <int>, iat: <unix>}` and
`sig = HMAC-SHA256(payload, ingestSecret)`. The `tow1.` prefix mirrors the
existing `tot_` API-token convention (`lib/api-tokens.ts`) so tokens are
recognizable in logs and secret scanners.

**Secret.** `TASK_ORCH_INGEST_SECRET` if set; otherwise derived as
`HMAC-SHA256(AUTH_SECRET, "task-orch-ingest-v1")` so existing deployments need
no new secret staging (`fly-deploy.sh` stage 5 gains an optional line, not a
required one). Verification is constant-time compare, mirroring
`lib/api-tokens.ts`.

**Minting.** At Machine-create time inside `buildFlyWorkerEnv(runId)`:
`TASK_ORCH_INGEST_TOKEN: mintIngestToken(runId, currentEpoch)`. Minting is a
pure function of `(runId, epoch, secret)` — no DB insert at machine-create
time, which matters because `create()`/`resume()` already have enough failure
modes and the cold-recover path re-creates Machines.

**Why not the alternatives:**

- *DB-backed token row* (the `api_tokens` pattern): trivial revocation, but a
  bcrypt row per run adds a write to Machine creation, a lookup+compare to
  every ingest call, and a new lifecycle (who prunes rows for reaped runs?).
  The epoch scheme below gets revocation with one integer column and no per-op
  bcrypt.
- *JWT*: same cryptography as HMAC with more surface (header alg confusion,
  library dependency) and nothing we need (no third-party verifier, no claims
  audience). Rejected for the same reason `lib/api-tokens.ts` doesn't use JWTs.
- *Trust the 6PN private network*: unacceptable — the untrusted agent code
  runs *inside* the private network. The token must live only in the worker
  *process* env and *must be added to Tier 0's `SECRET_ENV_DENYLIST`* the
  moment it is introduced, so tool subprocesses never see it. (Worst case if
  it still leaks: the holder can append messages/events/status to *its own
  run* — the same authority the worker legitimately has — versus today's
  leak-the-whole-database. That asymmetry is the entire point of Tier 2.)

**Lifetime.** No `exp` claim. Suspended Machines resume with their original
env (`resume()` → `startMachine` keeps createMachine-time env; PR #90's defer
path relies on this), and the runner lifecycle keeps stopped Machines up to
7 days — an expiry long enough to cover that is long enough to be useless, and
a short one breaks resume. Validity is bounded instead by:

1. **Run terminality** — every handler runs the same `lib/runs.ts` guards as
   the DB path (post-Tier-1: terminal-status transitions are idempotent
   no-ops; messages/events to cancelled runs are as acceptable via API as they
   are via today's direct DB path — no regression, no new authority).
2. **The epoch check** — see below.

**Revocation: `agent_runs.ingest_epoch int not null default 0`.** The token
embeds the epoch at mint time; the handler compares it to the row's current
value (it loads the run row anyway for guards — no extra query). Bump the
epoch exactly where we decide an old worker is dead or unwanted:

- `cancel()` — a cancelled run's outstanding tokens die.
- `reconcileOrphanedRuns()`'s genuine-orphan fail branch (`setError` path) —
  the Machine we're declaring dead can't come back as a zombie writer.

Do **not** bump on the resumable re-dispatch branch or on suspend/resume: the
same Machine comes back with the same env, and its token must stay valid.
Cold-recover (`createMachine` after the old Machine is gone) mints a fresh
token at the *current* epoch; if the old Machine is somehow still alive both
tokens verify, and double-writer protection falls to the same run-row guards
(claim CAS, terminal no-op) that protect the DB path today — equivalent
semantics, radically smaller blast radius.

**Machine resume answer (open question 1).** Resume is a non-event: stateless
verification + no expiry + epoch-not-bumped-on-resume means the original env's
token keeps working across suspend/resume cycles, exactly matching PR #90's
env-is-immutable reality.

## Decision 2 — Endpoint shape: one batch route, `POST /api/ingest/runs/[id]`

A single route file `app/api/ingest/runs/[id]/route.ts`. Request:

```jsonc
POST /api/ingest/runs/42
Authorization: Bearer tow1.eyJ2IjoxLCJydW4iOjQyLCJlcG9jaCI6MCwiaWF0IjoxNzg0fQ.…
{
  "ops": [
    { "opId": "42:7:0001", "kind": "message", "role": "agent", "content": "…" },
    { "opId": "42:7:0002", "kind": "event",   "type": "…", "payload": { } },
    { "opId": "42:7:0003", "kind": "status",  "status": "completed",
      "patch": { "prUrl": "…", "result": { } } }
  ]
}
→ 200 { "results": [ {"opId":"42:7:0001","ok":true,"id":9871}, … ] }
```

- **Batch, ordered, per-op results.** Workers buffer during a server-deploy
  window and flush in order; one batch request replays the buffer without N
  round-trips. Ops apply sequentially; a hard per-op failure is reported in
  `results` without aborting the batch (the worker decides what to do —
  status ops are the only order-critical ones and the worker sends those
  synchronously anyway).
- **Why one generic route, not typed routes:** the middleware session-auth
  gate (`middleware.ts`) needs exactly one new exemption prefix
  (`/api/ingest`), following the `/api/mcp` precedent (exempt from the session
  cookie gate, does its own Bearer verification). Typed sub-routes would
  triple the exempt surface for zero validation benefit — the `kind`
  discriminator is a zod union, validated as strictly as separate routes
  would be.
- **Path/token binding:** the `[id]` in the path must equal the token's `run`
  claim; mismatch → 403 before any parsing of `ops`. Per-run scoping is
  enforced by the *route*, not by trusting op payloads.
- **Handlers reuse `lib/runs.ts`.** `kind: "message"` → `persistMessage`;
  `kind: "event"` → the existing event-insert helpers; `kind: "status"` → the
  Tier-1 transactional finalize helpers (same CAS guards, same idempotent
  no-op semantics, same event-row shape the reaper's `latestEventStatus`
  parses). The API is a transport, not a second implementation: server-local
  code paths and worker-API code paths converge on identical functions, so
  behavior cannot fork.
- **`status` ops carry an allowlisted `patch`** of the companion columns the
  worker writes with a transition today (`error`, `completedAt`, `result`,
  `prUrl`, `branch`, `sdkSessionId`, `parkReason`, `pendingQuestion`).
  Anything outside the allowlist is rejected — the token authorizes *these
  writes to this run*, nothing else. Notably absent: `workerScope`,
  `workerPid`, `heartbeatAt`, `status: "pending"` (dispatch parking stays a
  DB write under the PR #90 contract).

**Coexistence with session auth (open question 2):** `middleware.ts` adds
`/api/ingest` to the bypass list next to `/api/mcp`; the route handler does
Bearer verification itself. No interaction with NextAuth.

## Decision 3 — Idempotency keys, DB-backed

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
transaction** (for status ops, the same transaction Tier 1 already opens). On
`(run_id, op_id)` conflict the op is not reapplied; the stored `result` is
returned. This makes worker retries across server redeploys exact-once in
effect: a retry of a batch whose response was lost replays as pure reads.
`opId` is worker-generated and deterministic (`<runId>:<turn>:<seq>`), so even
a worker crash-restart that rebuilds its buffer can't double-apply. Rows are
pruned with the existing runner-lifecycle sweeps once a run is terminal +
retention window (they're small; `on delete cascade` already ties them to run
deletion).

## Decision 4 — Which writes migrate (open question 3)

**Migrate behind the API (v1):**

| Write | Today | Why it moves |
|---|---|---|
| `agent_messages` appends | `persistMessage` direct INSERT | Content write; highest volume of the sensitive class |
| `agent_events` appends (status mirrors, `runner_deferred`, child lifecycle, etc. — every worker-side `emit*`) | direct INSERT | Content write; same |
| Status transitions + companion column patch | UPDATE + INSERT (Tier 1: one tx) | The incident-1 write; centralizing it in the server process makes every finalize observable |

**Stay on the DB path (justified):**

| Write/read | Justification |
|---|---|
| Heartbeats (`touchHeartbeat`, 20s cadence) | Pure liveness; moving them makes the single web Machine a hard dependency for lease liveness — during a deploy every worker's lease would age toward `HEARTBEAT_STALE_MS` in lockstep. Explicit non-goal. |
| Claim/release CAS, `deferRunForServerDispatch` | Conditional-UPDATE-as-CAS is the dispatch machinery; the API would reimplement the same statements with a network hop in the middle. Explicit non-goal (PR #90 contract). |
| All reads (run row, message context, `readStreamSince`, `run_input` LISTEN) | Readers don't move — explicit non-goal. |
| Worker log flusher (`worker-log-store`) | Bulky, chunked, self-healing, low sensitivity; migrating it buys little risk reduction. Candidate for a later phase, noted, not v1. |

**Consequence stated honestly:** because heartbeats, claims, and reads stay on
the DB path, **Tier 2 alone does not allow dropping `DATABASE_URL` from worker
env**. Tier 2 removes the *sensitive content writes* from the worker's DB
authority and proves the transport. The final step (separate, later) needs one
of: (a) moving the residual worker DB traffic (heartbeat bumps, claim
release, context reads) behind the API once it has an availability story, or
(b) replacing the worker's `DATABASE_URL` with a *narrowly-privileged Postgres
role* (per-run row-level security on the handful of remaining tables). That
choice is out of scope here and must be its own design.

## Decision 5 — Failure semantics (open question 4)

Worker-side client policy, per op:

1. **Try API** with short retry (3 attempts, 0.5s/1s/2s backoff, 10s budget).
   The server deploy window (single Machine, rolling restart) is seconds; this
   absorbs it invisibly.
2. **Fall back to the DB path** (the exact code that runs today) when the API
   stays down and `TASK_ORCH_INGEST=on` (not `strict`). The worker holds
   `DATABASE_URL` throughout Tier 2's rollout, so fallback is free, preserves
   the "3 deploys mid-incident harmed nothing" property, and keeps ordering:
   ops are sent sequentially (awaited), so a fallback op N lands before op
   N+1 regardless of transport.
3. **Buffering:** in-memory is only a transport detail of the retry window
   (the batch being retried). We do *not* build a durable worker-side spool:
   with DB fallback available there is nothing to spool for, and the
   idempotent `opId` scheme makes replay of an uncertain batch safe.

Interaction with the heartbeat lease and the reaper: heartbeats stay on the DB
path, so an API outage does not age the lease — a worker stuck in API retry
keeps heartbeating and the reaper stays away. The failure matrix:

| API | Worker→DB | Outcome |
|---|---|---|
| down | up | Fallback writes via DB; nothing lost (today's behavior). |
| up | down | **The incident-1 scenario, improved:** content writes flow via API (server's own DB connection); only heartbeats suffer. If the DB outage outlasts `HEARTBEAT_STALE_MS` (5 min) the reaper may reclaim — but post-Tier-1 finalize is atomic and post-Tier-2 the reaper *sees* the completed status the API landed, so it no longer mislabels delivered runs. |
| down | down | Worker retries both; if >5 min, lease expires and the reaper reclaims. Late replay by the original worker is harmless: `opId` dedup + terminal-status no-op guards + (if reaped via fail path) epoch bump rejecting the old token. |

`strict` mode (API-only, no DB fallback) exists in the flag from day one but
is a **post-`DATABASE_URL`-drop** posture; flipping it requires the final-step
design above (heartbeats over API + a lease long enough to ride out deploys).

## Decision 6 — run_stream relaying is unaffected (open question 5)

`run_stream` is a NOTIFY channel fired by AFTER-INSERT **triggers** on
`agent_events` / `agent_messages` (migration 0001). Triggers fire regardless
of which process performs the INSERT; moving the INSERT from the worker's
connection to the server's connection changes nothing about what readers see.
`readStreamSince` re-reads durable rows by cursor; `relayRunStream` /
`sendMessageToRun` tail exactly as before. The one worker-side *listen*
(`run_input`, waking a live chat worker on new user messages) is a read-path
concern and stays on the worker's DB connection per Decision 4. No reader
moves; no reader can tell the difference.

## Decision 7 — Rollout (env-flag gated, image-skew tolerant)

`TASK_ORCH_INGEST` = `off` (default) | `shadow` | `on` | `strict`, resolved
**server-side** and passed to workers pre-resolved via `buildFlyWorkerEnv`,
exactly like `TASK_ORCH_NESTED_DISPATCH` (workers can't compute server
defaults). Alongside it: `TASK_ORCH_INGEST_URL` (default
`http://${FLY_APP_NAME}.flycast` — 6PN-internal, fly-proxy routes to the web
service; overridable for local/docker) and `TASK_ORCH_INGEST_TOKEN` (Decision
1).

- **`off`:** nothing changes; token still minted and passed (harmless), server
  route live but unused. Lets us stage server + image before any behavior
  change.
- **`shadow`:** worker writes via the DB path (authoritative) AND fires the
  same ops at the API with a `shadow: true` marker; the server verifies,
  dedups, and logs but discards effects. Proves auth, batching, and
  idempotency under real traffic with zero risk.
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

Rollout order: (1) ship server route + token minting (`off`); (2) rebuild
runner image (`fly-deploy.sh` step 4 or `runner-image-nightly.yml`); (3) flip
`shadow`, watch the server-side ingest log for a few days of real runs;
(4) flip `on`; (5) DB fallback stays supported until the separate final-step
design lands — at minimum 7 days past `on` (max suspended-Machine age) before
even discussing `strict`.

## Security summary

- Token scope: write-only, run-scoped, epoch-revocable, content-only (no
  control-plane verbs, no reads, no other runs' ids accepted by the route).
- Token lives only in the worker process env; added to Tier 0's
  `SECRET_ENV_DENYLIST` so agent tool subprocesses never inherit it, and it is
  never echoed into logs (log the `run`/`epoch` claims, never the sig).
- Exfiltrated-token blast radius: attacker can append content to the run they
  already control the agent of — no privilege beyond what prompt-injecting
  the agent already grants. Compare `DATABASE_URL`: full read/write of every
  table for every user. This asymmetry is the acceptance criterion for the
  whole tier.
- The server route rate-limits per run (simple token bucket keyed by runId) so
  a misbehaving worker cannot amplify into the DB via the server.

## Diagnosability (incident 3, partial)

Every ingest failure is now a *server-side* log line with runId, opId, kind,
and error class — versus today's silently-swallowed worker-side write errors.
`touchHeartbeat`'s swallow itself is out of scope (heartbeats stay DB-path),
but "worker's write path broken" becomes visible the moment traffic shifts to
the API.

## Open items deliberately deferred

- `GH_TOKEN` removal from worker env (Tier 0 residual; askpass socket or
  root-owned credential file — separate design).
- Worker log flusher migration.
- The `DATABASE_URL` end-state choice: API-for-everything vs scoped Postgres
  role + RLS (Decision 4).
- Heartbeat error surfacing (incident 3 root fix).
