# Worker Ingest API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** BLOCKED on human approval of the companion design doc
(`docs/superpowers/specs/2026-07-06-worker-ingest-api-design.md`). Do not
start Task 1 until the design's Status line says Approved.

**Goal:** Workers write run messages, events, and status transitions through
`POST /api/ingest/runs/[id]` authenticated by a per-run HMAC token, flag-gated
(`TASK_ORCH_INGEST=off|shadow|on|strict`), with the DB path as automatic
fallback — so the sensitive content writes leave the worker's DB authority
while heartbeats/claims/dispatch/reads stay on the DB path per the PR #90
contract.

**Architecture:** See the design doc. Summary: stateless HMAC token
(`tow1.<payload>.<sig>`, `{v, run, epoch, iat}`) minted in `buildFlyWorkerEnv`,
revoked by bumping `agent_runs.ingest_epoch` on cancel/orphan-fail; one batch
route reusing the existing `lib/runs.ts` write functions (post-Tier-1
transactional helpers) with per-op idempotency rows in `ingest_ops`; worker
client tries API (3 retries / 10s budget) then falls back to the direct DB
write it performs today.

**Tech Stack:** TypeScript, Next.js route handler, Drizzle ORM (Postgres),
zod for the op union, Vitest. No new dependencies (HMAC via node:crypto).

## Global Constraints

- Prerequisites: Tier 0 (env scrub — the new token must join
  `SECRET_ENV_DENYLIST`) and Tier 1 (transactional finalize helpers the
  status-op handler calls) must be merged first.
- The "pending row is the dispatch request" contract is untouchable: the
  ingest route must reject `status: "pending"` and never touch
  `workerScope`/`workerPid`/`heartbeatAt` (allowlist in the op schema).
- Old workers (image without the client) against a new server, and new
  workers against an old server (404), must both keep working via the DB
  path — every task below must keep `TASK_ORCH_INGEST=off` a true no-op.
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
- [ ] Failing tests: mint→verify round-trip returns `{runId, epoch}`; verify
      rejects (a) tampered payload, (b) tampered sig, (c) wrong run id
      claim vs expected, (d) stale epoch, (e) garbage/`tot_`-prefixed input;
      constant-time compare used (assert via implementation, not timing);
      secret resolution prefers `TASK_ORCH_INGEST_SECRET`, falls back to
      HKDF-style derivation from `AUTH_SECRET`, throws when neither set.
- [ ] Implement `mintIngestToken(runId, epoch)` / `verifyIngestToken(token)`
      with node:crypto HMAC-SHA256 + `timingSafeEqual`.

### Task 2: `ingest_epoch` column + `ingest_ops` table migration

**Files:**
- Modify: `db/schema.ts`
- Create: migration via `npm run db:generate`
- Test: `__tests__/ingest/schema.test.ts` (or fold into Task 3's tests)

**Steps:**
- [ ] Add `ingestEpoch: integer("ingest_epoch").notNull().default(0)` to
      `agentSessions`; add `ingestOps` table
      (`run_id` FK cascade, `op_id` text, `result` jsonb, `created_at`,
      PK `(run_id, op_id)`).
- [ ] Generate + apply migration; verify `initDb()` runs it in the test
      schema.

### Task 3: Epoch bumps on cancel and orphan-fail

**Files:**
- Modify: `lib/runs.ts` (`cancel()`, `reconcileOrphanedRuns()` fail branch)
- Test: extend `__tests__/reconcile-orphaned-runs.test.ts`,
  `__tests__/runs-cascade.test.ts`

**Steps:**
- [ ] Failing tests: cancel bumps epoch; orphan-fail (setError branch) bumps
      epoch; the resumable re-dispatch branch and the completed-via-stranded-
      event branch do NOT bump; suspend/resume paths never touch it.
- [ ] Implement (fold the bump into the same transaction as the status write
      where one exists — Tier 1 helpers accept extra `set` columns).

### Task 4: Ingest route + op handlers

**Files:**
- Create: `app/api/ingest/runs/[id]/route.ts`, `lib/ingest/handlers.ts`,
  `lib/ingest/ops.ts` (zod op union + status-patch allowlist)
- Modify: `middleware.ts` (add `/api/ingest` bypass beside `/api/mcp`)
- Test: `__tests__/ingest/route.test.ts` (call handlers directly, per repo
  convention for route logic), `__tests__/ingest/handlers.test.ts`

**Steps:**
- [ ] Failing tests — auth: missing/malformed Bearer → 401; valid token but
      path run id ≠ claim → 403; stale epoch → 403; cancelled-run token after
      cancel (Task 3 bump) → 403.
- [ ] Failing tests — ops: message op inserts an `agent_messages` row
      identical in shape to `persistMessage`'s; event op matches the emit*
      row shape; status op goes through the Tier-1 transactional helper
      (terminal idempotent no-op observed; CAS preserved; one status event);
      status patch allowlist rejects `workerScope`/`heartbeatAt`/
      `status: "pending"`; batch applies in order and reports per-op results;
      NOTIFY trigger fires for API-inserted rows (assert via
      `readStreamSince` cursor pickup).
- [ ] Failing tests — idempotency: same `opId` replayed → effect applied
      once, stored `result` returned; replay of a whole batch is pure reads;
      `ingest_ops` row written in the same tx as the effect (rollback test:
      break the effect, assert no `ingest_ops` row).
- [ ] Implement route (Bearer parse → verify → zod parse → sequential
      handler loop) + handlers delegating to existing `lib/runs.ts`
      functions; per-run token-bucket rate limit; never log token material.
- [ ] `shadow` handling: `{shadow: true}` request flag → verify + dedup-log
      + discard effects, return results marked `shadow`.

### Task 5: Worker-side client with DB fallback

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
      then DB fallback, op order preserved across a mixed
      fallback/success sequence; `on` + 404 (old server) → permanent
      per-process fallback latch; `shadow` → DB write AND fire-and-forget
      API call; deterministic `opId` (`run:turn:seq`) stable across a
      client rebuild.
- [ ] Implement with global `fetch`, `TASK_ORCH_INGEST_URL` base, sequential
      awaited sends, in-memory batch only for the retry window.

### Task 6: Env wiring + Tier-0 denylist + deploy docs

**Files:**
- Modify: `lib/runner/fly.ts` (`buildFlyWorkerEnv`: mint
  `TASK_ORCH_INGEST_TOKEN`, pass resolved `TASK_ORCH_INGEST` +
  `TASK_ORCH_INGEST_URL`), `lib/agent-backend/env-scrub.ts`
  (add `TASK_ORCH_INGEST_TOKEN` and `TASK_ORCH_INGEST_SECRET` to
  `SECRET_ENV_DENYLIST`), `docs/fly-deployment.md`, `fly-deploy.sh`
  (optional secret staging line)
- Test: extend `__tests__/nested-dispatch.test.ts` env assertions +
  `__tests__/agent-backend/env-scrub.test.ts`

**Steps:**
- [ ] Failing tests: worker env contains a verifiable token for the right
      runId/current epoch; contains resolved flag + URL; env-scrub denylist
      covers the new vars; token absent when the secret is unconfigured
      (flag forced `off`).
- [ ] Implement; document the rollout order and version-skew matrix in
      `docs/fly-deployment.md`.

### Task 7: Rollout verification (manual, per design Decision 7)

- [ ] Deploy server with `TASK_ORCH_INGEST=off`; confirm no behavior change.
- [ ] Rebuild runner image (`fly-deploy.sh` step 4 or trigger
      `runner-image-nightly.yml`).
- [ ] Flip `shadow`; run real workloads; inspect server ingest logs for
      auth/dedup/shape errors over several days.
- [ ] Flip `on`; verify a full run (create → messages → PR → finalize) with
      the worker's DB content-writes silent; verify a deploy mid-run rides
      the retry/fallback path with zero lost writes.
- [ ] Keep DB fallback ≥7 days past `on` (max suspended-Machine age) before
      any `strict` discussion — `strict` is out of scope for this plan.
