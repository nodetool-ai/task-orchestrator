# Worker Ingest API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** BLOCKED on human approval of the companion design doc
(`docs/superpowers/specs/2026-07-06-worker-ingest-api-design.md`, Draft v2).
Do not start Task 1 until the design's Status line says Approved.

**Goal:** Workers write run messages, events, and status transitions through
`POST /api/ingest/runs/[id]` authenticated by a per-run, per-worker-generation
HMAC token, flag-gated (`TASK_ORCH_INGEST=off|shadow|on|strict`), with the DB
path as automatic fallback — so the sensitive content writes leave the
worker's DB authority while heartbeats/claims/dispatch/reads stay on the DB
path per the PR #90 contract.

**Architecture:** See the design doc (v2). Summary: stateless HMAC token
(`tow1.<payload>.<sig>`, `{v, run, gen, iat}`) minted in `buildFlyWorkerEnv`
against `agent_runs.worker_generation`, which bumps on every replacement-
Machine provisioning and on cancel/close/worker-death/orphan-fail; one batch
fail-fast route whose handlers call the same tx-parametric write cores the DB
path calls, with per-op idempotency rows (`ingest_ops`) in the same
transaction as the effect; shadow mode dedups against a separate
`ingest_shadow_ops` table; worker client tries API (3 retries / 10s budget)
then falls back to the direct DB write it performs today.

**Tech Stack:** TypeScript, Next.js route handler, Drizzle ORM (Postgres),
zod for the op union, Vitest. No new dependencies (HMAC via node:crypto).

## Global Constraints

- Prerequisites: Tier 0 (PR #91 — the new token joins `SECRET_ENV_DENYLIST`)
  and Tier 1 (PR #92 — the transactional status helpers Task 4 refactors)
  are merged.
- The "pending row is the dispatch request" contract is untouchable: the
  ingest route must reject `status: "pending"` and never touch
  `workerScope`/`workerPid`/`heartbeatAt` (allowlist in the op schema).
- Old workers (image without the client) against a new server, and new
  workers against an old server (404), must both keep working via the DB
  path — every task below must keep `TASK_ORCH_INGEST=off` a true no-op.
- Shadow mode must never write `ingest_ops`, never delay or fail the
  authoritative DB write, and never let a shadow-path bug surface as a worker
  error.
- `npx tsc --noEmit` clean and full `npx vitest run` green (known
  order-dependent failure in `__tests__/runs-claim-release.test.ts` excepted)
  after every task.
- Match existing idioms: env save/restore per test
  (`__tests__/nested-dispatch.test.ts:19-27`), fixture runs via
  `create({ goal, defer: true })`, per-fork Postgres schemas from
  `vitest.setup.ts`.

---

### Task 1: Token mint/verify module

**Files:**
- Create: `lib/ingest/token.ts`
- Test: `__tests__/ingest/token.test.ts`

**Steps:**
- [ ] Failing tests: mint→verify round-trip returns `{runId, gen}`; verify
      rejects (a) tampered payload, (b) tampered sig, (c) wrong run id claim
      vs expected, (d) stale generation vs expected, (e) garbage /
      `tot_`-prefixed input; `timingSafeEqual` used for the sig compare;
      secret resolution prefers `TASK_ORCH_INGEST_SECRET`, accepts
      `TASK_ORCH_INGEST_SECRET_PREVIOUS` as a secondary *verification* key
      (mint always uses primary; a token minted under the previous secret
      still verifies during the rotation window), falls back to a derivation
      from `AUTH_SECRET` with the domain-separated info label
      `task-orchestrator:worker-ingest-token:v1` (dev only), throws when
      nothing is set.
- [ ] Implement `mintIngestToken(runId, gen)` /
      `verifyIngestToken(token, { expectedRunId, currentGen })` with
      node:crypto HMAC-SHA256; distinct error codes for `bad_token`,
      `run_mismatch`, `stale_generation`.

### Task 2: `worker_generation` column + `ingest_ops` / `ingest_shadow_ops` tables

**Files:**
- Modify: `db/schema.ts`
- Create: migration via `npm run db:generate`
- Test: folded into Tasks 3/5 tests

**Steps:**
- [ ] Add `workerGeneration: integer("worker_generation").notNull().default(0)`
      to `agentSessions`; add `ingestOps` (`run_id` FK cascade, `op_id` text,
      `result` jsonb, `created_at`, PK `(run_id, op_id)`) and
      `ingestShadowOps` (same shape, separate table — shadow must never touch
      the authoritative dedup keys).
- [ ] Generate + apply migration; verify `initDb()` runs it in the test
      schema.

### Task 3: Generation bumps (the revocation policy)

**Files:**
- Modify: `lib/runner/fly.ts` (`create()`, cold-recover branch of
  `resume()`), `lib/runs.ts` (`cancel()`, `close()`,
  `reconcileOrphanedRuns()` orphan-fail branch, `handleWorkerDeath()`
  non-resumable failure paths)
- Test: `__tests__/ingest/worker-generation.test.ts` + extend
  `__tests__/reconcile-orphaned-runs.test.ts`, `__tests__/runs-cascade.test.ts`,
  `__tests__/fly-provider.test.ts`

**Steps:**
- [ ] Failing tests — bumps: fresh `create()` bumps before mint (token in the
      Machine env carries the new generation); cold-recover bumps (the
      replacement's token gen > the dead Machine's); `cancel()` bumps;
      `close()` bumps; orphan-fail (setError branch) bumps;
      `handleWorkerDeath` non-resumable path bumps.
- [ ] Failing tests — non-bumps (just as important): `startMachine` resume of
      the same Machine does NOT bump; suspend does NOT bump; an ordinary
      `completed`/`failed` landing does NOT bump; the reaper's
      completed-via-stranded-event branch does NOT bump.
- [ ] Implement. Bump = single `UPDATE ... SET worker_generation =
      worker_generation + 1` committed before `buildFlyWorkerEnv` reads the
      row to mint (provisioning sites) or folded into the same transaction as
      the status write (cancel/close/fail sites — Tier 1 helpers accept extra
      `set` columns).

### Task 4: Tx-parametric refactor of the write cores (blocker for Task 5)

**Files:**
- Modify: `lib/runs.ts`
- Test: existing suites (`atomic-finalize`, `reconcile-orphaned-runs`,
  `runs-cascade`, dispatch suites) must stay green — this task changes no
  behavior.

**Steps:**
- [ ] Extract `persistMessageCore(tx, …)`, `insertEventCore(tx, …)`, and
      `applyStatusCore(tx, …)` (the body currently inside `applyStatusTx`'s
      transaction callback) so each accepts a Drizzle transaction handle.
      Existing exports (`persistMessage`, the `emit*` helpers,
      `applyStatusTx`) become thin wrappers that open their own transaction
      (or pass `db` where a single statement needs no tx) and delegate —
      DB-path behavior byte-identical.
- [ ] Full suite green + `tsc` clean before starting Task 5; the ingest
      handler and the legacy DB path must call the SAME cores from here on.

### Task 5: Ingest route + op handlers

**Files:**
- Create: `app/api/ingest/runs/[id]/route.ts`, `lib/ingest/handlers.ts`,
  `lib/ingest/ops.ts` (zod op union + status-patch allowlist)
- Modify: `middleware.ts` (add `/api/ingest` bypass beside `/api/mcp`)
- Test: `__tests__/ingest/route.test.ts`, `__tests__/ingest/handlers.test.ts`

**Steps:**
- [ ] Failing tests — auth: missing/malformed Bearer → 401; valid token but
      path run id ≠ claim → 403 `run_mismatch`; stale generation (row bumped
      after mint, e.g. by a Task-3 cancel or a simulated replacement) → 403
      `stale_generation`; the error body never echoes the token.
- [ ] Failing tests — ops: message op inserts a row identical in shape to
      `persistMessage`'s (via `persistMessageCore`); event op matches the
      emit* row shape; status op goes through `applyStatusCore` (terminal
      idempotent no-op observed; CAS preserved; one status event); status
      patch allowlist rejects `workerScope`/`heartbeatAt`/`status: "pending"`;
      NOTIFY trigger fires for API-inserted rows (assert via
      `readStreamSince` cursor pickup).
- [ ] Failing tests — terminal-run append rejection: message/event ops
      against an already-terminal run → per-op `run_terminal` error; but a
      REPLAY of an op that landed before the run went terminal returns its
      stored success (dedup lookup runs before the terminal check) — this
      pins "a worker cannot append to a completed run just because its
      generation never bumped".
- [ ] Failing tests — batch fail-fast: [ok, fail, ok] → op1 applied, op2
      error reported, op3 `skipped` and NOT applied; replayed-from-dedup ops
      count as success, not failure.
- [ ] Failing tests — idempotency: same `opId` replayed → effect applied
      once, stored `result` returned; `ingest_ops` row written in the same tx
      as the effect (rollback test: break the effect, assert no `ingest_ops`
      row).
- [ ] Failing tests — shadow: shadow request dedups against
      `ingest_shadow_ops` only, `ingest_ops` untouched, no effects applied;
      a thrown error inside the shadow handler still returns a
      success-shaped response; a later NON-shadow request with the same
      `opId` applies for real (the poisoning regression test).
- [ ] Implement route (Bearer parse → verify(run, gen) → zod parse →
      sequential fail-fast handler loop) + handlers delegating to the Task-4
      cores; per-run token-bucket rate limit; structured per-op logging
      (runId, gen, opId, kind, error class — never token material).

### Task 6: Worker-side client with DB fallback

**Files:**
- Create: `lib/ingest/client.ts`
- Modify: the worker-side write seams in `lib/runs.ts` (persistMessage /
  emit* / finalize call sites reached from `driveDispatchedRun`) to route
  through a thin `ingestOrDb(op, dbFallbackFn)` shim
- Test: `__tests__/ingest/client.test.ts`

**Steps:**
- [ ] Failing tests: `TASK_ORCH_INGEST` unset/`off` → shim calls the DB
      fallback directly, zero fetches (the no-op guarantee); `on` + API 200 →
      no DB write; `on` + API down (fetch rejects) → 3 retries with backoff
      then DB fallback, op order preserved across a mixed fallback/success
      sequence; `on` + fail-fast response → failed op and `skipped` suffix
      fall back to DB in original order; `on` + 404 (old server) → permanent
      per-process fallback latch; `on` + 403 `stale_generation` → permanent
      per-process fallback latch (superseded worker); `shadow` → DB write is
      authoritative and never delayed/failed by the shadow send (inject a
      shadow-send crash and assert the DB write still lands);
      deterministic `opId` = `runId:gen:turnOrdinal:seq` with `gen` sourced
      from the token env, stable across a client rebuild within the same
      generation.
- [ ] Implement with global `fetch`, `TASK_ORCH_INGEST_URL` base, sequential
      awaited sends, in-memory batch only for the retry window.

### Task 7: Env wiring + Tier-0 denylist + deploy docs

**Files:**
- Modify: `lib/runner/fly.ts` (`buildFlyWorkerEnv`: mint
  `TASK_ORCH_INGEST_TOKEN` from the current `worker_generation`, pass
  resolved `TASK_ORCH_INGEST` + `TASK_ORCH_INGEST_URL`),
  `lib/agent-backend/env-scrub.ts` (add `TASK_ORCH_INGEST_TOKEN`,
  `TASK_ORCH_INGEST_SECRET`, `TASK_ORCH_INGEST_SECRET_PREVIOUS` to
  `SECRET_ENV_DENYLIST`), `docs/fly-deployment.md`, `fly-deploy.sh`
  (stage `TASK_ORCH_INGEST_SECRET`; note the `_PREVIOUS` rotation window)
- Test: extend `__tests__/nested-dispatch.test.ts` env assertions +
  `__tests__/agent-backend/env-scrub.test.ts`

**Steps:**
- [ ] Failing tests: worker env contains a token verifying against the right
      runId + current generation; contains resolved flag + URL; env-scrub
      denylist covers the new vars; the consistency rule — secret configured
      + flag `off` → token still minted; NO secret configured → no token AND
      effective mode forced `off` regardless of the flag value (both halves
      asserted).
- [ ] Implement; document in `docs/fly-deployment.md`: the rollout order, the
      version-skew matrix, the dedicated-secret requirement for
      `shadow`/`on`, and the ≥7-day dual-secret rotation window.

### Task 8: `ingest_ops` retention sweep

**Files:**
- Modify: `lib/runner/lifecycle.ts` (or wherever the existing sweep lives —
  verify) 
- Test: `__tests__/ingest/retention.test.ts`

**Steps:**
- [ ] Failing tests: sweep deletes `ingest_ops` rows for runs terminal longer
      than the retention window (default 30d, `TASK_ORCH_INGEST_OPS_TTL_MS`)
      and `ingest_shadow_ops` rows older than 7d; non-terminal runs' rows
      untouched; cascade on run delete already covered by FK.
- [ ] Implement as a step in the existing lifecycle sweep tick.

### Task 9: Rollout verification (manual, per design Decision 7)

- [ ] Stage `TASK_ORCH_INGEST_SECRET`; deploy server with
      `TASK_ORCH_INGEST=off`; confirm no behavior change.
- [ ] Rebuild runner image (`fly-deploy.sh` step 4 or trigger
      `runner-image-nightly.yml`).
- [ ] Flip `shadow`; run real workloads; inspect server ingest logs for
      auth/dedup/shape errors — and for `stale_generation` rejections
      (zombie writers, previously invisible) — over several days.
- [ ] Flip `on`; verify a full run (create → messages → PR → finalize) with
      the worker's DB content-writes silent; verify a deploy mid-run rides
      the retry/fallback path with zero lost writes; verify a cancel mid-run
      produces a `stale_generation` rejection if the worker races a write.
- [ ] Keep DB fallback ≥7 days past `on` (max suspended-Machine age) before
      any `strict` discussion — `strict` is out of scope for this plan.
