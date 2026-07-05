# Agent event system — design

Status: proposal, revision 3. Companion to the message-passing review on this
branch: today the parent→child path (spawn / append_message) is robust, but the
child→parent path is pull-only — a parent burns a whole turn (and a worker
container) busy-polling `await_session`, and if the parent dies its children's
results are never consumed. This design inverts that: **everything that happens
in the world becomes a durable event row in Postgres, addressed to a run, and
delivery of an event is what wakes a parked run.** Agents stop polling and
start sleeping.

Revision 2 tightens the semantics rev 1 was overconfident about. The
distinctions between *woken*, *delivered to the transcript*, *read by the
model*, and *handled by the agent* are where durable-agent systems actually
break, so the design now treats them as four different things:

- **woken** — a dispatch happened because pending events existed (§6)
- **injected** — the event's digest frame is durably in the transcript (§6;
  event lifecycle `pending → injected`, never "consumed")
- **read** — the model's turn ran over the frame; observable only as the turn
  having completed (`run_turn_id` on the event links the two)
- **handled** — an application-level judgment this layer deliberately does NOT
  track with ack timeouts; supervision (watchdog timers, attempt counters,
  supersession, the silent-skip guard of §6.2) is the mechanism instead

Revision 3 adds the operations-at-scale layer: table partitioning and
pending-set partial indexes (§1.1), TTL/archival for long-lived daemon runs
(§11), a control-event class the LLM cannot swallow (§6.6), a flat
resource-lock table instead of per-call subtree walks (§5.2), the silent-skip
guard (§6.2), and executor context-growth management via generation rollover
(§9.1).

Everything composes with the existing machinery rather than replacing it: the
per-run lock, the heartbeat lease, `dispatchRun`, the pending-run pump
(`lib/run-dispatch.ts`), the GH webhook router (`lib/github-webhook-handler.ts`),
and the durable stream tail (`lib/run-stream.ts`) all keep their jobs.

---

## 1. Two kinds of event, two tables

The existing `agent_events` table is a **telemetry stream**: things a run did,
tailed by the UI/SSE. It is append-only, per-run, and nothing consumes it. That
contract stays untouched.

What's missing is an **inbox**: events addressed *to* a run, that the run is
expected to see, and whose arrival wakes it. New table:

```ts
// db/schema.ts
export const inboxEvents = pgTable(
  "inbox_events",
  {
    id: serial("id").primaryKey(),
    // Who this event is addressed to. ON DELETE CASCADE with the run.
    targetRunId: integer("target_run_id").notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    // Dotted taxonomy, e.g. 'child.result', 'gh.pr.merged', 'timer.fired'.
    type: text("type").notNull(),
    // jsonb, not text: we need querying, partial indexes, and debuggability
    // on payloads (e.g. "all child.result events where payload->>'status' =
    // 'blocked'"). Drizzle's jsonb typing friction is worth it.
    payload: jsonb("payload").notNull().default({}),

    // ── Delivery role (§5) ─────────────────────────────────────────────
    // 'owner'      — operational: addressed to the run expected to ACT.
    // 'supervisor' — informational copy for a parent/ancestor: visibility
    //                and audit, NOT a request to act. Does not wake by
    //                itself; rides along in the next digest.
    audience: text("audience").notNull().default("owner"),

    // ── Provenance & correlation (§4) ──────────────────────────────────
    // 'run' | 'github' | 'timer' | 'task' | 'budget' | 'system' | 'user'
    sourceKind: text("source_kind").notNull(),
    // e.g. the child run id, the GH delivery id, the timer id.
    sourceId: text("source_id"),
    // Groups an exchange: a question and its answer, a rework request and
    // the result it produced. Free-form, producer-chosen (question ids,
    // 'task:<id>:attempt:<n>').
    correlationId: text("correlation_id"),
    // The inbox event that caused the action that produced THIS event
    // (e.g. parent's fix-append was caused by child.exception #812 → the
    // eventual new child.result carries causationEventId=812). Gives an
    // auditable causal chain across the tree.
    causationEventId: integer("causation_event_id"),
    // Rework generation of the source child when sourceKind='run' (§4.3).
    attempt: integer("attempt"),
    // Set when re-addressed up the parent chain (§5): the run id it was
    // ORIGINALLY addressed to.
    bubbledFrom: integer("bubbled_from"),
    // Idempotency: producers that can double-fire (webhook redeliveries,
    // reaper + death-monitor races) write a stable key; a partial unique
    // index on (target_run_id, dedupe_key) makes the second insert a no-op.
    dedupeKey: text("dedupe_key"),

    // ── Lifecycle (§6): pending → injected | superseded | error ────────
    status: text("status").notNull().default("pending"),
    // The turn that received this event's digest frame. Links "injected"
    // to a concrete transcript position; NULL until injection.
    runTurnId: integer("run_turn_id"),
    // For status='error': why injection/rendering failed (§6.5).
    errorReason: text("error_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
    injectedAt: ts("injected_at"),
  },
  (t) => ({
    // PARTIAL index on the pending set only. Every event leaves 'pending'
    // exactly once, so this index stays proportional to the live backlog
    // (usually tiny) no matter how large the table grows — the wake scan,
    // the pump sweep, and the claim subquery all hit it and none of them
    // degrade with total event volume.
    targetPendingIdx: index("inbox_target_pending_idx")
      .on(t.targetRunId, t.audience, t.id)
      .where(sql`status = 'pending'`),
    dedupeIdx: uniqueIndex("inbox_dedupe_idx").on(t.targetRunId, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
    correlationIdx: index("inbox_correlation_idx").on(t.correlationId),
  })
);
```

Lifecycle states, precisely:

- **`pending`** — durable, not yet in any transcript. The only state that
  wakes and the only state a claim touches.
- **`injected`** — its digest frame is committed to the transcript of turn
  `run_turn_id`. This means *delivered*, nothing stronger: the agent may still
  ignore it, act wrongly on it, or crash mid-turn (the frame replays on
  resume — the transcript, not the event row, is the source of truth once
  injected).
- **`superseded`** — invalidated by a newer event before injection (§4.3):
  e.g. a stale `child.result` from attempt 2 still pending when attempt 3's
  result arrives. Superseded events are retained (audit) but never injected.
- **`error`** — quarantined poison event (§6.5).

There is deliberately **no `handled` state**. "Handled" is an agent-level
judgment the storage layer cannot verify; pretending otherwise (ack timeouts,
escalate-on-unacked) reintroduces the timeout-tuning swamp this design
removes. What the system offers instead: the causal chain
(`causation_event_id`), attempt supersession, watchdog timers, and persona
rules that record decisions durably (task notes) — supervision over
acknowledgment.

Timers get their own small table (§7) because a timer is a *future* event and
the inbox holds only things that already happened.

Design rule: **producers write facts; the delivery layer owns fan-out.** A
producer emits one logical event; addressing (owner + supervisor copies +
exception routing) is resolved at insert time by a single `emitInboxEvent()`
helper so the rules in §5 live in exactly one place.

### 1.1 Operating this as a queue — churn, vacuum, partitions

Postgres with `FOR UPDATE SKIP LOCKED` is a proven queue pattern, but every
event is a row that gets written once and updated once (`pending → injected`),
and at scale — hundreds of concurrent children, webhook fan-out, supervisor
copies — that update churn produces dead tuples faster than default
autovacuum keeps up, bloating indexes and eventually the 15s pump tick itself.
Countermeasures from day one, not retrofitted:

- **Partial pending index** (in the schema above): the wake scan, the pump
  sweep, and the claim subquery all hit an index proportional to the live
  backlog (usually tiny), never to total event volume — every event leaves
  `pending` exactly once.
- **Declarative range partitioning on `created_at` (monthly).** Old
  partitions are effectively frozen (their rows are all terminal-state), so
  vacuum work concentrates on the current partition, and retention (§11)
  becomes `DETACH PARTITION` + archive/drop instead of a million-row DELETE.
  The primary key becomes `(created_at, id)` — fine, since all lookups are by
  target/status/dedupe, not bare id.
- **Table-level autovacuum tuning** on `inbox_events` and `run_timers`
  (`autovacuum_vacuum_scale_factor ≈ 0.01`, lowered
  `autovacuum_vacuum_cost_delay`) plus `fillfactor = 85` so the
  `pending → injected` update is usually a same-page HOT update that doesn't
  touch indexes at all.
- **The pump tick is self-limiting:** its sweep query is bounded (`LIMIT`,
  pending-only partial index) and instrumented; if a tick overruns the
  interval, ticks coalesce (the existing pump already runs ticks serially)
  and the overrun is a metric alarm, not a cascade.

---

## 2. Envelope

Every event renders into digests (§6.3) with a uniform envelope:

```jsonc
{
  "event_id": 4812,
  "type": "child.result",
  "occurred_at": "2026-07-05T14:03:22Z",
  "audience": "owner",
  "source": { "kind": "run", "id": "241" },
  "attempt": 3,
  "correlation_id": "task:T-17:attempt:3",
  "causation_event_id": 4790,
  "bubbled_from": null,
  "payload": { /* type-specific, §3 */ }
}
```

---

## 3. Taxonomy

### 3.1 Child lifecycle (`source_kind: run`)

Addressed to the parent (`parent_run_id`). Emitted from the run status
transitions that already exist in `lib/runs.ts` (`emitStatus`, `failRun`,
`handleWorkerDeath`, `reconcileOrphanedRuns`) — each transition gains one
`emitInboxEvent()` call.

| type | when | payload highlights |
|---|---|---|
| `child.spawned` | child row created | run_id, persona, task_id, goal |
| `child.started` | first turn begins | run_id, attempt |
| `child.result` | **the expected end** — child called `report_result` (§4) | run_id, attempt, `result` (structured), pr_url, cost |
| `child.exception` | child called `raise`, or landed `failed` | run_id, attempt, code, message, `recoverable`, details |
| `child.died` | infra death: OOM kill, worker crash, orphaned lease reaped | run_id, attempt, exit_code, oom_killed, worker_log tail, `resumable` |
| `child.timeout` | child exceeded `budget_max_seconds` | run_id, attempt, elapsed |
| `child.budget_exhausted` | soft budget stop | run_id, spent_usd, cap |
| `child.cancelled` | user/API cancelled the child | run_id, by |
| `child.question` | child parked and asked its parent (§8) | run_id, question_id, question, context |
| `child.progress` | optional checkpoint the child chose to publish | run_id, attempt, note, pct |

`child.result` vs `child.exception` vs `child.died` is the load-bearing
distinction:

- **result** — the protocol was followed; the payload is trustworthy
  structured data (§4). The parent's happy path.
- **exception** — the *agent* hit a condition it could name. Deliberate,
  carries an error code the parent can branch on, and routes per §5.3.
- **died** — the *infrastructure* failed; the agent never got to speak. The
  payload carries forensics (exit code, worker log tail) plus `resumable`, so
  the parent can decide between re-dispatch and giving up. Synthesized by
  `handleWorkerDeath` and `reconcileOrphanedRuns` with dedupe key
  `died:<run_id>:<worker_scope>` so the death monitor and the reaper racing
  each other produce one event, not two.

### 3.2 GitHub (`source_kind: github`)

Produced by `handleWebhookEvent` (`lib/github-webhook-handler.ts`), which
already normalizes deliveries and matches them to runs by PR url / branch.
Today it writes to the telemetry stream and triggers autofix; it additionally
enqueues inbox events. `dedupe_key = gh:<delivery_id>:<run_id>`.

| type | payload highlights |
|---|---|
| `gh.pr.review_submitted` | pr_url, state (approved \| changes_requested \| commented), reviewer, body |
| `gh.pr.comment` | pr_url, author, body, path/line for review comments |
| `gh.pr.merged` | pr_url, merged_by, sha |
| `gh.pr.closed` | pr_url (closed without merge) |
| `gh.pr.pushed` | pr_url, sha — new commits on the PR branch |
| `gh.ci.completed` | pr_url, conclusion (success \| failure), check name, logs url |

Routing: `audience: owner` to the run that **owns** the PR (matched by
`pr_url`/`branch` as today); `audience: supervisor` copy to its parent (§5.2).
Exactly one run is expected to act.

### 3.3 Timers (`source_kind: timer`)

| type | payload |
|---|---|
| `timer.fired` | timer_id, note, requested_minutes, set_at |

### 3.4 Task / plan state (`source_kind: task`)

Emitted from `repo.transitionTask` / `transitionPlan`. `audience: owner` to
non-terminal runs whose `task_id`/`plan_id` matches; `audience: supervisor`
copy to their parents. Lets an executor learn a human moved a task without
polling `list_tasks`.

| type | payload |
|---|---|
| `task.transitioned` | task_id, from, to, by |
| `plan.transitioned` | plan_id, from, to, by |

### 3.5 Budget & liveness (`source_kind: budget` / `system`)

| type | when |
|---|---|
| `budget.warning` | a run crosses 80% of `budget_max_usd` / `max_turns` — `owner` to the run itself, `supervisor` copy to its parent |
| `child.stalled` | heartbeat stale but not yet reaped — early warning, cheaper than waiting for `child.died` |
| `run.cancel_requested` | the cross-process cancel flag flipped; informational mirror of the existing mechanism |
| `user.message` | a human appended to the run from the UI while it was parked — the append already wakes it; the event makes the wake reason legible in the digest |

### 3.6 Custom (`source_kind: user`, agent-emitted)

`events__emit(target_run_id, type: "custom.<name>", payload, correlation_id?)`
— restricted to targets **within the caller's tree** (same root, checked with
the existing `walkParentChain`/`collectSubtree` helpers). The
sibling-coordination escape hatch (implementor A tells implementor B "the
shared interface changed") without opening a general cross-tree messaging
surface.

---

## 4. The result contract

### 4.1 Tools

The review found that "the result" today is `extractLatestAssistantText` —
prose scraping. This design makes the result an explicit protocol.

**`report_result`** (registered for every spawned child):

```
report_result({
  status: "success" | "failed" | "blocked",
  summary: string,             // ≤ 2000 chars, human-readable
  data?: object,               // machine-readable, persona-specific
  pr_url?: string,
  needs?: string,              // when blocked: what would unblock it
})
```

Effects, in one transaction where possible: persist the result JSON to a new
`agent_runs.result` column (jsonb; superseding the 200-char `outcome` for new
code — `outcome` stays for the review-verdict compatibility path), mark the
run `completed` (or `failed` for `status: "failed"`), and emit `child.result`
to the parent. The tool result tells the child its turn is over — the runner
ends the turn on seeing it, like the planning extension's stage gates.

**`raise`**:

```
raise({
  code: string,                // e.g. "merge_conflict", "missing_credentials"
  message: string,
  recoverable: boolean,        // "resume me with instructions and I can continue"
  details?: object,
})
```

Marks the run `failed`, stores the exception in `result`, emits
`child.exception`. `recoverable: true` signals the parent that
`spawn__append_message` on this child is a sensible fix path (the child is a
resumable worktree run and keeps its branch/session).

### 4.2 Enforcement — the protocol must not depend on model discipline

- A child that reaches `completed` **without** calling `report_result` still
  produces a `child.result` event, synthesized with `implicit: true` and
  `summary` = last agent text. Parents can treat implicit results as
  lower-trust. (Persona prompts instruct children to always report; the
  synthesizer is the backstop.)
- A child that lands `failed` without `raise` produces `child.exception` with
  `code: "unhandled"`, message = `agent_runs.error`.
- Death produces `child.died`, never a fake result.

### 4.3 Attempts and supersession — first-class, not a footnote

Resumable implement children legitimately complete **multiple times**: every
`append_message` fix cycle re-completes the run. So "one terminal event per
child" is false as stated, and pretending otherwise would make parents
mishandle stale results — especially with GitHub events interleaving out of
order. The model instead:

- **`agent_runs.attempt`** (integer, default 1): incremented by every
  turn-starting resume of a terminal-but-resumable child (`runs.append` on a
  completed implement run). The child's current rework generation.
- Every `source_kind: run` event carries the child's `attempt` at emit time.
- **Terminal invariant, corrected:** every spawned child produces exactly one
  terminal event **per attempt** — `child.result`, `child.exception`, or
  `child.died` — deduped by `terminal:<run_id>:<attempt>`. `child.cancelled`
  is a per-run singleton (`cancelled:<run_id>`); cancellation ends the run,
  not an attempt.
- **Supersession at emit time:** when `emitInboxEvent()` inserts a terminal
  child event, it marks any still-`pending` terminal event from the same
  `(run_id)` with a lower `attempt` as `superseded` in the same transaction.
  A parent that slept through attempts 2 and 3 wakes to one live result (3)
  and an audit trail, not two contradicting ones.
- **Staleness rule for parents (persona + digest rendering):** act only on
  the highest `attempt` seen per child; a `gh.*` event carrying a `sha` that
  predates the child's latest reported head is context, not a trigger. The
  digest renderer sorts and annotates this (§6.3) so the model doesn't have
  to reconstruct it.
- `correlation_id` ties a rework loop together: the parent's fix-append sets
  `correlation_id` (e.g. `task:T-17:attempt:3`) and the resulting
  `child.result` carries it plus `causation_event_id` = the exception/review
  event that started the loop.

---

## 5. Addressing: operational vs supervisory delivery

Rev 1 bubbled everything to the "nearest live ancestor" as if any ancestor
could act. Wrong: a grandparent typically lacks the task context and the
authority to repair a grandchild — visibility and action are different needs.
Resolved centrally in `emitInboxEvent()`:

### 5.1 Operational delivery (`audience: owner`)

Exactly one run is the actor. Child lifecycle → the direct parent. GH → the
run owning the PR. Timer → the run that set it. Owner events wake (§6.2).

### 5.2 Supervisory delivery (`audience: supervisor`)

For parent-visible types (`gh.*`, `task.*`, `budget.warning`, and terminal
child events), one copy to the direct parent — **informational**. Supervisor
events do NOT wake a parked run; they ride along in the next digest, rendered
in a separate "for your awareness" section. This is how "the parent sees the
child's PR events" without creating duplicate reasoning: seeing ≠ acting.

Acting is additionally fenced at the tool layer, not just by prompt: `gh_pr__*`
mutation tools refuse to operate on a PR another live run owns — "your
implementor owns this PR; message it instead." Belt and suspenders against a
supervisor copy triggering a parent-side merge that races the child.

Ownership is answered by a flat **`resource_locks`** table, not a subtree walk
per tool call (recursive ancestor/descendant queries on every PR mutation
would be an easy hot spot as trees multiply, cheap as any one walk is at
depth ≤ 3):

```ts
export const resourceLocks = pgTable("resource_locks", {
  // e.g. 'pr:https://github.com/o/r/pull/42', 'task:T-17'
  resource: text("resource").primaryKey(),
  ownerRunId: integer("owner_run_id").notNull()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  acquiredAt: ts("acquired_at").notNull().defaultNow(),
});
```

A run acquires the lease when it opens/adopts the PR (or is spawned on a
task); the lease is released when the run reaches a terminal status with no
pending rework (the same transitions that emit terminal events — one more
line in `emitInboxEvent`'s transaction). The mutation guard is then a single
primary-key lookup: locked by someone else and that someone is alive →
refuse with the owner's run id; locked by a dead run or unlocked → proceed
(and take the lease). The table doubles as the UI's "who owns what" view.

### 5.3 Exception routing

`child.exception` / `child.died` go `audience: owner` to the direct parent.
If the direct parent is terminal (`failed`/`cancelled`/`closed`):

- the event is re-addressed to the nearest **live** ancestor with
  `audience: supervisor` and `bubbled_from` set — the ancestor is *informed*,
  and its persona may choose to adopt the orphan (it has `spawn__get_run` and
  `append_message`), but nothing assumes it will;
- AND the event is flagged as an **unhandled tree failure** on the root
  (UI badge + telemetry), so a fully-dead chain surfaces to the human.

Events never silently vanish; they also never conscript an arbitrary ancestor
into a repair job it can't do.

---

## 6. Delivery: park, wake, claim, digest

This is the piece that kills polling — and the piece where the real bugs
live, so the primitives are spelled out.

### 6.1 One parked status

One new non-terminal status joins `SESSION_STATUSES` (`lib/types.ts`):
**`parked`**, with a companion column **`agent_runs.park_reason`**
(`'waiting' | 'sleeping' | 'question'`). Rev 1's separate `waiting`/`sleeping`
statuses doubled the branching in the reaper, dispatch, append handling, UI,
and tests for a distinction that is human-facing, not machine-facing — the
wake rules are identical (any owner event wakes; sleep just guarantees a
`timer.fired` eventually exists). `park_reason` carries the human-facing
nuance; status machinery sees one state.

`parked` behaves like `idle` for the reaper (`reconcileOrphanedRuns` skips it —
no worker and no heartbeat is healthy here, not orphaned) and like `idle` for
`append_message` (a human or agent message wakes it too). `isTerminalStatus`
stays false.

### 6.2 Wake

One rule: **inserting a pending owner-audience event for a parked run
dispatches it.** `emitInboxEvent()` ends with the same claim-and-dispatch path
`append_message` uses (`runDispatch.dispatchRun`), guarded by the existing
per-run lock and lease checks so a wake racing a human message is safe —
whoever claims first wins, and the loser's events are picked up by the digest
anyway. If the target is mid-turn, do nothing: turn-boundary injection catches
it. If dispatch is deferred by the admission gate, the run sits `pending` with
its events queued — the existing pump retries; events are not lost.

The pump (`pumpTick`, 15s) gets a **wake sweep** as half 3: find parked runs
with pending owner events and dispatch them. This is the belt to the emit-time
suspenders — a wake lost to a crash between insert and dispatch is retried
within 15s, forever, because the state ("parked + pending owner events") is
durable. No wake is ever load-bearing on an in-process callback.

**Wake-loop guard:** a parked run woken more than N times (default 10) within
an hour whose turns each end with no tool calls besides re-parking gets a
`system.wake_loop` supervisor event on its parent and a UI flag, and further
wakes for `supervisor`-only backlogs are suppressed. Cheap self-wake spam
(agent sets a 1-minute timer in a loop) is bounded by timer limits (§7).

**Silent-skip guard:** the failure mode the no-`handled`-state gamble (§1)
actually costs is a *stall*, not a crash — the model reads the digest,
muses about it, emits no state-mutating tool call, and re-parks; nothing is
wrong in the database, and the next scheduled wake may be a 45-minute
watchdog away. So the runner checks at turn end: **woken by ≥1
owner-audience event + zero state-mutating tool calls this turn** (the
runner already sees every tool call; mutating vs read-only is a static
property of each tool) → instead of honoring the agent's park, it arms a
short system timer (5 min) with note `"re-check: woken but took no action"`
and lets the park proceed. One free pass — the re-wake digest includes the
nudge, and a *second* consecutive silent skip emits `system.silent_skip` to
the parent and the UI. The penalty for an LLM shrug drops from
watchdog-scale (45 min) to minutes, without pretending the platform can
judge whether inaction was correct (sometimes it is — hence a nudge and an
escalation, not a forced action).

### 6.3 The claim primitive — exactly one way to take events

All consumption goes through a single function; nothing else touches
`status='pending'`:

```
claimInboxEvents(runId, { audiences, maxEvents?, types? })
  PRECONDITION: caller holds the per-run lock for runId (asserted — the
  lock handle is a parameter, not ambient hope).
  UPDATE inbox_events
     SET status = 'injected', run_turn_id = $turn, injected_at = now()
   WHERE id IN (SELECT id FROM inbox_events
                 WHERE target_run_id = $1 AND status = 'pending'
                   AND audience = ANY($audiences) [AND type = ANY($types)]
                 ORDER BY id
                 [LIMIT $max]
                 FOR UPDATE SKIP LOCKED)
   RETURNING *;
```

Why this shape:

- **Lock ownership is explicit.** Both call sites — turn-boundary injection
  and mid-turn `events__poll` — already run inside the per-run lock (the
  lock spans the whole turn). The primitive takes the lock token and asserts
  it rather than assuming the invariant holds forever. Two dispatches for the
  same run are impossible under the lock; this makes the dependency visible
  and testable instead of implicit.
- **The inner `SELECT ... FOR UPDATE SKIP LOCKED` + ordered subquery** makes
  the claim atomic and ordered even if the lock invariant is ever broken
  (e.g. a future call site outside the lock): concurrent claimers get
  disjoint sets, never duplicates, and within one claimer order is `id`
  ascending. Defense in depth, not the primary guarantee.
- **Claim and transcript-persist commit in one transaction** (§6.4), so
  "claimed but never written anywhere" cannot exist.

### 6.4 Digest injection — a structured frame, not a fake user message

Rev 1 injected the digest as a synthetic user message. That mixes control
plane into the natural-language stream: prompt dynamics ("the user said...")
start affecting event handling, and the transcript lies about who said what.
Instead:

When a turn starts (fresh dispatch or resume), the runner — inside the per-run
lock, before building the SDK prompt — calls `claimInboxEvents` and persists
the claimed events as **one structured frame**: an `agent_messages` row with
`role: 'system'` and a single typed content block
`{ type: 'event_digest', events: [envelope, ...] }` (envelopes of §2, id
order, owner events first, then a separated supervisor section, with the §4.3
staleness annotations precomputed). Claim + frame insert commit together —
exactly-once into the transcript, at-least-once in wake effort. A crash after
commit replays the already-persisted frame on resume (the existing replay
behavior); the transcript, not the event rows, is authoritative from then on.

**Rendering happens at prompt-build time**, per model/persona: the frame is
data; the prompt builder renders it into whatever the SDK needs (a system
block, a tool-result-shaped block — an SDK detail, not a storage contract).
The UI renders the same frame as a "woken by: …" card. Nothing downstream
parses prose to recover event structure.

Coalescing is deliberate: ten CI events during a night's sleep become one
wake and one frame, not ten turns. Per-target ordering is by `id` (serial),
which matches emit order; cross-target ordering is not promised and doesn't
need to be.

### 6.5 Poison events

A malformed payload must not wedge the run in a dispatch loop. Frame
construction validates each claimed event independently (envelope schema +
size caps); one that fails to render is marked `status='error'` with
`error_reason`, emits telemetry + a `system.event_quarantined` supervisor
event to the run's parent, and is **excluded from the frame** — the turn
proceeds with the rest. If frame persistence itself fails, the claim
transaction rolls back (events return to `pending`) and dispatch backs off
exponentially per run (tracked on the dispatch attempt, capped, then the run
is flagged in the UI rather than looped forever). Quarantined events are
visible in the UI for manual replay after a fix.

### 6.6 Mid-turn reads — and the control-event class

`events__poll({ types?, max? })` — non-blocking; calls `claimInboxEvents`
under the same held lock and returns the events as the tool result (which the
SDK persists as a tool-result block — again a real frame, not prose). For the
executor that just merged a PR and wants to check whether anything arrived
meanwhile, without ending its turn. (No blocking `events__wait` tool:
*parking is how you wait.* A blocking wait inside a turn is exactly the
pinned-worker pattern being removed.)

**Control events are not claimable — the LLM never processes its own death
warrant.** If `run.cancel_requested` could be claimed by a mid-turn poll,
a model that ignored that one entry in the batch would have "swallowed" its
own cancellation: the event is `injected`, nothing is `pending`, and no
machinery fires again. So the taxonomy is split into two classes:

- **`notify`** (everything in §3 by default): claimable, digestible,
  LLM-facing.
- **`control`** (`run.cancel_requested`, hard `budget_exhausted`, and any
  future must-enforce type): **excluded from `claimInboxEvents` entirely** —
  the type filter is applied inside the primitive, not trusted to callers.
  Control facts are enforced by the platform layer exactly as they are
  today: the `cancel_requested` flag is polled at heartbeat cadence and
  aborts the turn (`startHeartbeatWithCancel`), budget gates run in the
  runner between turns. Their inbox rows exist only to make the enforcement
  *visible* in the next digest ("your previous turn was aborted: cancel
  requested by …") — the row is marked `injected` by the platform when the
  enforcement happens, never claimed by a poll.

Corollary for `child.died` / `budget.warning`: these stay `notify` (the
parent deciding is the point), but they are **wake-priority** — a mid-turn
poll that returns them is fine, and if they arrive while parked they always
wake even when a `supervisor`-suppression (§6.2 wake-loop guard) is active.

---

## 7. Timers

The user-facing guarantee: **every agent, in every tools profile, can always
go to sleep for N minutes.** The timer tools live outside the profile system
(like the built-in tools), so no profile misconfiguration can strand an agent
with no way to yield.

```ts
export const runTimers = pgTable("run_timers", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  fireAt: ts("fire_at").notNull(),
  note: text("note"),
  // pending | fired | cancelled
  status: text("status").notNull().default("pending"),
  createdAt: ts("created_at").notNull().defaultNow(),
  firedAt: ts("fired_at"),
}, (t) => ({ dueIdx: index("run_timers_due_idx").on(t.status, t.fireAt) }));
```

Tools:

- **`timer__sleep(minutes, note?)`** — the always-available one. Inserts a
  timer, ends the turn, parks the run (`park_reason: 'sleeping'`). Wakes on
  `timer.fired` or any earlier owner event (sleep is a *maximum* wait, like
  `select()` with a timeout, not a hard suspension).
- **`timer__set(minutes, note?)`** — schedule a future `timer.fired`
  *without* parking; returns `timer_id`. How an agent arms a watchdog for its
  own children: "wake me in 45 minutes even if nothing has happened." Multiple
  may be armed.
- **`timer__cancel(timer_id)`** — cancel a pending timer you own.

**Limits — always-available must not mean unlimited.** Being outside the
profile system makes timers a capability escape hatch, so they get their own
caps, enforced in the tools:

- `minutes` clamped to [1, 1440] (24h);
- max **4 pending timers per run** (a watchdog plus slack; `timer__set`
  returns an error naming the oldest one past that);
- max pending timers per **tree** (default 64) so a runaway fan-out can't arm
  thousands;
- a per-run minimum effective sleep (60s) plus the wake-loop guard (§6.2)
  bound self-wake spam: the cheapest possible loop is one wake/minute and
  gets flagged within the hour.

Firing: the pump tick claims due timers (`UPDATE ... SET status='fired' WHERE
status='pending' AND fire_at <= now() RETURNING *` — atomic across concurrent
pumps) and emits `timer.fired` with `dedupe_key = timer:<id>`. Resolution is
the pump interval (15s), plenty for minute-scale sleeps. Timers are rows, so
they survive restarts; a server that was down when a timer came due fires it
on the next tick — late, never lost.

`await_session`'s 1.5s status poll becomes legacy: the executor pattern
`spawn → park → digest` replaces it (§9). The tool stays for compatibility and
one-off scripting.

---

## 8. Child → parent questions

With parking in place, the missing half-duplex from the review costs one tool
— but a question is a *stateful exchange*, not a fire-and-forget event, so it
gets explicit state instead of hope:

**`ask_parent(question, context?, timeout_minutes = 60)`**:

1. Generates a `question_id`, emits `child.question` to the parent with
   `correlation_id = question_id`, arms a timer for `timeout_minutes`, and
   parks the child (`park_reason: 'question'`). The pending question
   (id, text, asked_at, deadline) is stored in `agent_runs.result`-adjacent
   state (a small `pending_question` jsonb column) so both sides and the UI
   can see it.
2. The parent answers with **`answer_question(child_run_id, question_id,
   answer)`** — a thin wrapper over `spawn__append_message` that stamps the
   answer with the `question_id`, clears the child's `pending_question`, and
   cancels its timeout timer. First answer wins; a second `answer_question`
   for the same id errors ("already answered at …"), which also defuses the
   both-parked-both-assume crossfire: an answer that arrives after the child's
   timeout already fired is rejected with the child's recorded assumption, so
   the parent *knows* the child proceeded without it.
3. If the timer fires first, the child wakes with `timer.fired`
   (`correlation_id = question_id`), records its assumption in
   `pending_question` (state → `expired`, `assumption: ...`), and proceeds —
   or raises `code: "no_guidance"` if it can't. The parent's stale
   `child.question` event stays injected-but-moot; if the parent eventually
   answers, step 2's rejection tells it so.

Roots with no parent get an error from `ask_parent` telling them to ask the
human (UI notification) instead.

The social deadlock (child asks parent, parent asks child, both park) is not
prevented — it can't be, in general — but it is **bounded and legible**: both
sides carry deadlines, both record their assumptions durably, and the
`question_id` correlation makes the crossed wires reconstructable in the UI
rather than a mystery.

---

## 9. The executor, rewritten as an event loop

Persona workflow (`lib/personas/executor.ts`) under this design:

```
1. list_tasks; build the dependency graph.
2. start_session for EVERY ready task. timer__set(45, "watchdog") once.
3. timer__sleep(30) — park.
4. On wake, read the event_digest frame and dispatch on each OWNER event
   (supervisor section is context only):
   - child.result (implementor, success) → start_review(task, pr_url)
   - child.result (reviewer)             → verdict approve? gh_pr__pr_merge
                                           : append_message(implementor, concerns)
                                             [attempt counter in task notes]
   - child.result with stale attempt     → ignore (digest annotates; §4.3)
   - child.exception (recoverable)       → append_message(child, fix guidance)
   - child.exception / child.died (not)  → retry fresh once; then task → blocked + note
   - gh.pr.merged                        → task done arrives on its own; start
                                           newly-ready dependents
   - gh.ci.completed (failure, own PR)   → n/a (child owns it; supervisor copy
                                           is context — tool guard enforces, §5.2)
   - child.question                      → answer_question(child, qid, answer)
   - budget.warning                      → stop spawning; drain what's running
   - timer.fired (watchdog)              → spawn__get_run each outstanding child;
                                           anything stalled → cancel + retry or block
5. Tasks outstanding? → arm watchdog, park again (goto 3).
   All done/blocked  → transition_plan, report_result, exit.
```

Attempt counters and per-task decisions move from LLM memory into task notes
(durable), so a replaced executor resumes mid-plan: on its first turn it
rebuilds state from `list_tasks` + child runs (`parent_run_id` query) + notes
— the review's finding #4.

Between wakes the executor holds **no worker, no container, no tokens**. A
plan whose implementors take 40 minutes costs the executor a handful of short
turns instead of 40 minutes of pinned polling.

### 9.1 Context growth: digest frames accumulate — transcripts must be disposable

Event-driven wakes trade the polling swamp for a new pressure: every wake
appends a digest frame plus reasoning plus tool calls to one long transcript.
A 30-task plan with rework loops is easily 60–100 wakes; the executor's
context grows monotonically and will hit the window mid-plan. Three layers,
in order of leverage:

1. **Durable state lives outside the transcript — by rule, not hope.** The
   executor's decisions (attempt counters, blocked reasons, per-task phase)
   go to task notes; child state is queryable (`list_tasks`, children by
   `parent_run_id`, `resource_locks`); consumed events keep their rows. The
   transcript is therefore a *cache* of the executor's working memory, not
   the system of record — which is what makes the next two layers safe.

2. **Prompt-build-time frame compaction.** Because digests are stored as
   structured frames rendered at prompt-build time (§6.4), old frames can be
   compacted without touching storage: frames older than the last K wakes
   render as one-line summaries ("wake 12: child.result #241 attempt 2 →
   started review #250") and fully-resolved exchanges (result → review →
   merged, per `correlation_id`) collapse to their outcome. The rev-2
   decision to persist data instead of prose is what makes this a renderer
   feature instead of a migration.

3. **Generation rollover.** When compaction is no longer enough (token count
   crosses a threshold at turn start), the runner ends the executor run and
   spawns a **successor generation**: a fresh run, same persona/goal/budget
   lineage, `resume_of` pointing back, bootstrapped exactly like a replaced
   executor already is (§9: rebuild from tasks + children + notes — the
   design requires this rebuild to work anyway, so rollover is the same code
   path as crash recovery, exercised routinely instead of only in disasters).
   Mechanics: `agent_runs.superseded_by` on the old run;
   `emitInboxEvent()` resolves its target **through the supersession chain**
   (a small follow-the-pointer loop, capped) so in-flight children and
   webhooks addressed to the old run id land in the successor's inbox;
   still-`pending` events migrate in the same transaction; `resource_locks`
   and children's `parent_run_id` re-point. The tree budget already sums
   across the tree, so a rollover can't launder costs.

Layer 3 is also the answer for daemon-style runs (§11): a triage bot that
lives for months is not one infinite transcript but a chain of bounded
generations over durable external state.

---

## 10. Failure matrix

| scenario | today | with events |
|---|---|---|
| Child dies (OOM/crash) | parent polls until `await_session` timeout | `handleWorkerDeath` emits `child.died` → parent wakes in seconds, decides re-dispatch vs blocked |
| Child completes, parent waits | 1.5s poll loop holding a worker | `child.result` wakes a parked parent |
| Parent dies mid-supervision | children's results never consumed | parent is parked, not mid-turn, most of the time — nothing to orphan; if it dies mid-turn, reaper reaps it; exceptions re-route per §5.3 (inform a live ancestor, flag the root) |
| Child broke, parent must instruct fix | works today (append_message) | unchanged — now triggered by `child.exception{recoverable}` instead of a timeout post-mortem |
| Child needs parent input mid-task | impossible (parent pinned; ancestor-append guarded) | `ask_parent` with question state + deadline (§8) |
| Stale result after rework | n/a (results are prose) | attempt supersession at emit; digest staleness annotations (§4.3) |
| Wake itself is lost (crash between insert and dispatch) | n/a | durable state "parked + pending" re-swept by the pump every 15s |
| Poison event | n/a | quarantined to `error` with reason; turn proceeds; dispatch backs off instead of looping (§6.5) |
| Agent reads event, takes no action | n/a | silent-skip guard: 5-min re-check + nudge, then `system.silent_skip` escalation (§6.2) |
| Cancel/budget-stop swallowed by the model | n/a (cancel is platform-enforced) | stays platform-enforced: `control`-class events are unclaimable; heartbeat-cadence abort unchanged (§6.6) |
| Event storm (CI fan-out) | n/a | dedupe keys + digest coalescing: one wake, one frame |
| Self-wake / timer spam | n/a | timer caps + wake-loop guard (§6.2, §7) |
| Both sides stuck waiting for each other | append-to-ancestor deadlock guards | parking removes held locks; question deadlines + recorded assumptions make the social version legible (§8) |

## 11. Retention & observability

- `injected`/`superseded`/`error` events are kept (they're the audit trail of
  *why* a run acted) — but **not forever**. Cascade-with-the-tree alone
  assumes short-lived trees; a long-lived daemon run would accumulate an
  unbounded inbox that slowly drags every query that can't stay on the
  pending-only partial index. So retention is a hard TTL, not a hope:
  terminal-state events (`injected`/`superseded`/`error`) older than
  `INBOX_TTL_DAYS` (default 90) are dropped by detaching aged partitions
  (§1.1) — optionally archived to object storage as JSONL first for
  compliance-grade audit. `pending` events are exempt from TTL by
  construction (they live in the current partition; a pending event old
  enough to age out is itself an alarm — flagged, not silently dropped).
  The transcript keeps its own copy of every injected envelope (the digest
  frame), so dropping aged event rows never loses the record of what a run
  actually saw.
- The digest frame in the transcript carries event ids, so the UI renders
  "woken by: child.result #241 (attempt 3), gh.ci.completed" on the run page —
  every wake is explainable, and `run_turn_id` links each event to the turn
  that saw it.
- `correlation_id`/`causation_event_id` let the UI draw the causal chain of a
  rework loop across parent and child.
- Runs list badges: `parked (sleeping, 3 events queued)`, quarantine flags,
  wake-loop flags.
- Metrics from day one: wake latency (event `created_at` → turn start) — the
  health number for the whole system — plus quarantine count and
  supersession rate (a high rate means parents sleep too long or children
  churn).

## 12. Phasing

Delivery semantics are where the bugs live (duplicate wake, stale event,
crash between claim and frame persist, storm handling, parent-terminal
races), so nothing turns on wake behavior without having watched the events
flow first:

1. **Tables + emit.** `inbox_events` (partitioned, partial pending index,
   autovacuum settings — §1.1), `run_timers`, `resource_locks`,
   `emitInboxEvent()`, and producers: status transitions,
   `handleWorkerDeath`/reaper, webhook handler. Nothing consumes; verify
   volume, shape, dedupe hits, and vacuum behavior under load in the UI.
2. **Shadow mode.** The old polling paths (`await_session`, executor loops)
   keep running the system; a replay checker records, for every polling
   outcome ("await_session #N returned completed"), whether the
   corresponding terminal inbox event exists, matches attempt, and *would*
   have woken the right parent at the right time — and diffs the two. Storms
   and dedupe behavior get observed here under real load. Exit criterion:
   N days of zero unexplained divergence.
3. **Park + wake + frames.** `parked` status + `park_reason`, reaper
   exemption, `claimInboxEvents` (with the `control`-class exclusion baked
   into the primitive), wake-on-insert, pump wake-sweep, digest frames,
   poison quarantine, silent-skip guard, `timer__*`, `events__poll`. Opt-in
   per run tree (env/flag) before default-on.
4. **Result contract.** `report_result` / `raise` / `ask_parent` /
   `answer_question`, `agent_runs.result` + `attempt` + `pending_question`
   columns, synthesized terminal events, supersession, persona updates.
5. **Executor v2** on the event loop, with frame compaction; `await_session`
   marked legacy. Generation rollover (§9.1) ships here too — it reuses the
   crash-recovery rebuild, so it should not be deferred to "later".
6. Later, if scale demands: `LISTEN/NOTIFY` to cut the 15s wake tail to
   near-zero, TTL archival to object storage — optimizations on the same
   rows, not a redesign.
