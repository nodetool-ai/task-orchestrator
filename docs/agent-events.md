# Agent event system — design

Status: proposal. Companion to the message-passing review on this branch:
today the parent→child path (spawn / append_message) is robust, but the
child→parent path is pull-only — a parent burns a whole turn (and a worker
container) busy-polling `await_session`, and if the parent dies its children's
results are never consumed. This design inverts that: **everything that happens
in the world becomes a durable event row in Postgres, addressed to a run, and
delivery of an event is what wakes a parked run.** Agents stop polling and
start sleeping.

Everything here composes with the existing machinery rather than replacing it:
the per-run lock, the heartbeat lease, `dispatchRun`, the pending-run pump
(`lib/run-dispatch.ts`), the GH webhook router (`lib/github-webhook-handler.ts`),
and the durable stream tail (`lib/run-stream.ts`) all keep their jobs.

---

## 1. Two kinds of event, two tables

The existing `agent_events` table is a **telemetry stream**: things a run did,
tailed by the UI/SSE. It is append-only, per-run, and nothing consumes it. That
contract stays untouched.

What's missing is an **inbox**: events addressed *to* a run, that the run is
expected to consume, and whose arrival wakes it. New table:

```ts
// db/schema.ts
export const inboxEvents = pgTable(
  "inbox_events",
  {
    id: serial("id").primaryKey(),
    // Who should act on this event. ON DELETE CASCADE with the run.
    targetRunId: integer("target_run_id").notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    // Dotted taxonomy, e.g. 'child.result', 'gh.pr.merged', 'timer.fired'.
    type: text("type").notNull(),
    // JSON payload; shape per type (see §3).
    payload: text("payload").notNull().default("{}"),
    // Provenance: 'run' | 'github' | 'timer' | 'task' | 'budget' | 'system' | 'user'
    sourceKind: text("source_kind").notNull(),
    // e.g. the child run id, the GH delivery id, the timer id.
    sourceId: text("source_id"),
    // Set when this event was re-addressed up the parent chain (§5):
    // the run id it was ORIGINALLY addressed to.
    bubbledFrom: integer("bubbled_from"),
    // Idempotency: producers that can double-fire (webhook redeliveries,
    // reaper + death-monitor races) write a stable key; a partial unique
    // index on (target_run_id, dedupe_key) makes the second insert a no-op.
    dedupeKey: text("dedupe_key"),
    // pending → consumed. Consumed = injected into a turn (§6); there is no
    // separate 'delivered' state because injection and consumption are the
    // same transaction.
    status: text("status").notNull().default("pending"),
    createdAt: ts("created_at").notNull().defaultNow(),
    consumedAt: ts("consumed_at"),
  },
  (t) => ({
    // The wake scan: "does run X have pending events?"
    targetPendingIdx: index("inbox_target_pending_idx").on(t.targetRunId, t.status, t.id),
    dedupeIdx: uniqueIndex("inbox_dedupe_idx").on(t.targetRunId, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
  })
);
```

Design rule: **producers write facts; the delivery layer owns fan-out.** A
producer emits one logical event; addressing (owner + parent + bubbling) is
resolved at insert time by a single `emitInboxEvent()` helper so the rules in
§5 live in exactly one place.

Timers get their own small table (§7) because a timer is a *future* event and
the inbox holds only things that already happened.

---

## 2. Envelope

Every payload shares a common envelope so agents can parse events uniformly:

```jsonc
{
  "event_id": 4812,
  "type": "child.result",
  "occurred_at": "2026-07-05T14:03:22Z",
  "source": { "kind": "run", "id": "241" },
  "bubbled_from": null,          // run id when re-addressed upward
  "payload": { /* type-specific, §3 */ }
}
```

---

## 3. Taxonomy

### 3.1 Child lifecycle (`source_kind: run`)

Addressed to the parent (`parent_run_id`). These are emitted from the run
status transitions that already exist in `lib/runs.ts` (`emitStatus`,
`failRun`, `handleWorkerDeath`, `reconcileOrphanedRuns`) — each transition
gains one `emitInboxEvent()` call.

| type | when | payload highlights |
|---|---|---|
| `child.spawned` | child row created | run_id, persona, task_id, goal |
| `child.started` | first turn begins | run_id |
| `child.result` | **the expected end** — child called `report_result` (§4) | run_id, `result` (structured), pr_url, cost |
| `child.exception` | child called `raise`, or landed `failed` | run_id, code, message, `recoverable`, details |
| `child.died` | infra death: OOM kill, worker crash, orphaned lease reaped | run_id, exit_code, oom_killed, worker_log tail, `resumable` |
| `child.timeout` | child exceeded `budget_max_seconds` | run_id, elapsed |
| `child.budget_exhausted` | soft budget stop | run_id, spent_usd, cap |
| `child.cancelled` | user/API cancelled the child | run_id, by |
| `child.question` | child parked in `waiting` and asked its parent (§8) | run_id, question, context |
| `child.progress` | optional checkpoint the child chose to publish | run_id, note, pct |

`child.result` vs `child.exception` vs `child.died` is the load-bearing
distinction:

- **result** — the protocol was followed; the payload is trustworthy structured
  data (§4). The parent's happy path.
- **exception** — the *agent* hit a condition it could name. Deliberate,
  carries an error code the parent can branch on, and **bubbles** (§5).
- **died** — the *infrastructure* failed; the agent never got to speak. The
  payload carries forensics (exit code, worker log tail) plus `resumable`, so
  the parent can decide between re-dispatch and giving up. Synthesized by
  `handleWorkerDeath` and `reconcileOrphanedRuns` with a dedupe key of
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

Routing: the event is addressed to the run that **owns** the PR (matched by
`pr_url`/`branch` as today). If that run has a parent, the parent gets a copy
(§5) — this is how "the PR could be from a child, the parent sees it" works
without the parent subscribing to anything.

### 3.3 Timers (`source_kind: timer`)

| type | payload |
|---|---|
| `timer.fired` | timer_id, note, requested_minutes, set_at |

### 3.4 Task / plan state (`source_kind: task`)

Emitted from `repo.transitionTask` / `transitionPlan`, addressed to runs that
declared interest: any non-terminal run whose `task_id`/`plan_id` matches, plus
that run's parent. Lets an executor learn a human moved a task without polling
`list_tasks`.

| type | payload |
|---|---|
| `task.transitioned` | task_id, from, to, by |
| `plan.transitioned` | plan_id, from, to, by |

### 3.5 Budget & liveness (`source_kind: budget` / `system`)

| type | when |
|---|---|
| `budget.warning` | a run crosses 80% of `budget_max_usd` / `max_turns` — addressed to the run itself AND its parent, so the parent can wind down or top up before the hard stop |
| `child.stalled` | heartbeat stale but not yet reaped — early warning, cheaper than waiting for `child.died` |
| `run.cancel_requested` | the cross-process cancel flag flipped; informational mirror of the existing mechanism |
| `user.message` | a human appended to the run from the UI while it was parked — the append already wakes it; the event makes the wake reason legible in the digest |

### 3.6 Custom (`source_kind: user`, agent-emitted)

`events__emit(target_run_id, type: "custom.<name>", payload)` — restricted to
targets **within the caller's tree** (same root, checked with the existing
`walkParentChain`/`collectSubtree` helpers). This is the sibling-coordination
escape hatch (implementor A tells implementor B "the shared interface changed")
without opening a general cross-tree messaging surface.

---

## 4. The result contract

The review found that "the result" today is `extractLatestAssistantText` —
prose scraping. This design makes the result an explicit protocol:

**`report_result` tool** (registered for every spawned child):

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
`agent_runs.result` column (superseding the 200-char `outcome` for new code;
`outcome` stays for the review-verdict compatibility path), mark the run
`completed` (or `failed` for `status: "failed"`), and emit `child.result` to
the parent. The tool result tells the child its turn is over — the runner ends
the turn on seeing it, like the planning extension's stage gates.

**`raise` tool**:

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

**Enforcement — the protocol must not depend on model discipline:**

- A child that reaches `completed` **without** calling `report_result` still
  produces a `child.result` event, synthesized with `implicit: true` and
  `summary` = last agent text. Parents can treat implicit results as
  lower-trust. (Persona prompts instruct children to always report; the
  synthesizer is the backstop.)
- A child that lands `failed` without `raise` produces `child.exception` with
  `code: "unhandled"`, message = `agent_runs.error`.
- Death produces `child.died`, never a fake result.

So the invariant the parent can rely on: **every spawned child produces exactly
one terminal event — `child.result`, `child.exception`, or `child.died`** —
deduped by `terminal:<run_id>` (one terminal event per run, ever; a resumed
implement child that completes again after an append supersedes via
`terminal:<run_id>:<turn>`... see §10 note on resumable children).

---

## 5. Addressing & bubbling

Resolved centrally in `emitInboxEvent()`:

1. **Direct address.** Child lifecycle → parent. GH → owning run. Timer → the
   run that set it.
2. **Parent copy.** If the direct target has a live (non-terminal) parent and
   the event type is in the parent-visible set (`gh.*`, `task.*`,
   `budget.warning`), insert a second row addressed to the parent with
   `bubbled_from = <direct target>`. One level, not the whole chain — the
   grandparent supervises through its child, not around it. Depth is capped at
   3 (`MAX_DEPTH`), so this stays cheap.
3. **Exception bubbling.** `child.exception` and `child.died` walk **up** the
   chain to the nearest ancestor able to receive events — i.e. skip ancestors
   that are terminal (`failed`/`cancelled`/`closed`). If the direct parent is
   dead but the grandparent lives, the grandparent gets the event with
   `bubbled_from` set. If *no* live ancestor exists, address it to the root
   anyway and surface it in the UI as an unhandled tree failure — events must
   never silently vanish.

Bubbling happens **at emit time**, not as a retry-on-unconsumed escalation.
Escalation-on-ignore was considered and rejected: a parked parent always
consumes on its next wake (§6), so "parent saw it but chose to ignore it" and
"parent never woke" are indistinguishable without adding ack timeouts, which
reintroduces the timeout-tuning problem this design removes. The one genuinely
unhandled case — parent terminal — is detectable at emit time, which is when
step 3 handles it.

---

## 6. Delivery: park, wake, digest

This is the piece that kills polling.

### Parked statuses

Two new non-terminal statuses join `SESSION_STATUSES` (`lib/types.ts`):

- **`waiting`** — the run ended its turn expecting events (typically after
  spawning children, or after `ask_parent`). No worker, no heartbeat needed.
- **`sleeping`** — the run called `timer__sleep`; wakes on its timer **or** on
  any earlier inbox event (sleep is a *maximum* wait, like `select()` with a
  timeout, not a hard suspension).

Both behave like `idle` for the reaper (`reconcileOrphanedRuns` skips them — a
parked run with no heartbeat is healthy, not orphaned) and like `idle` for
`append_message` (a human or agent message wakes them too). `isTerminalStatus`
stays false for both.

### Wake

One rule: **inserting a pending inbox event for a parked run dispatches it.**
`emitInboxEvent()` ends with the same claim-and-dispatch path `append_message`
uses (`runDispatch.dispatchRun`), guarded by the existing per-run lock and
lease checks so a wake racing a human message is safe — whoever claims first
wins, and the loser's events are picked up by the digest anyway. If the target
is mid-turn, do nothing: the turn-boundary injection below catches it. If
dispatch is deferred by the admission gate, the run sits `pending` with its
events queued — the existing pump retries; events are not lost.

The pump (`pumpTick`, 15s) gets a **wake sweep** as half 3: find parked runs
with pending events and dispatch them. This is the belt to the emit-time
suspenders — a wake lost to a crash between insert and dispatch is retried
within 15s, forever, because the state ("parked + pending events") is durable.
No wake is ever load-bearing on an in-process callback.

### Digest injection

When a turn starts (fresh dispatch or resume), the runner — inside the per-run
lock, before building the SDK prompt — atomically claims all `pending` inbox
events for the run (oldest first, `UPDATE ... SET status='consumed' WHERE
target_run_id = $1 AND status='pending' RETURNING *`), renders them as **one**
synthetic user-role message (an `<events>` digest: the envelopes of §2, JSON,
in id order), and persists it via the same `agent_messages` path as any user
message. Consumption and injection commit together; a crash after commit
replays the already-persisted message on resume (the existing replay behavior),
so delivery is **exactly-once into the transcript, at-least-once in effort**.

Coalescing is deliberate: ten CI events during a night's sleep become one wake
and one digest, not ten turns. Per-target ordering is by `id` (serial), which
matches emit order; cross-target ordering is not promised and doesn't need to
be.

### Mid-turn reads

`events__poll({ types?, max? })` — non-blocking, returns and consumes pending
events during a turn. For the executor that just merged a PR and wants to check
whether anything arrived meanwhile, without ending its turn. (No blocking
`events__wait` tool: *parking is how you wait.* A blocking wait inside a turn
is exactly the pinned-worker pattern being removed. The persona prompt says:
"to wait for events, call `timer__sleep` or simply end your turn with children
outstanding.")

---

## 7. Timers

The user-facing guarantee: **every agent, in every tools profile, can always go
to sleep for N minutes.** The timer tools live outside the profile system (like
the built-in tools), so no profile misconfiguration can strand an agent with no
way to yield.

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
  timer, ends the turn, parks the run as `sleeping`. Wakes on `timer.fired` or
  any earlier event. Cap `minutes` (e.g. 24h) and clamp ≥ 1.
- **`timer__set(minutes, note?)`** — schedule a future `timer.fired` *without*
  parking; returns `timer_id`. This is how an agent arms a watchdog for its own
  children: "wake me in 45 minutes even if nothing has happened, so I can check
  on run #241." Multiple may be armed.
- **`timer__cancel(timer_id)`** — cancel a pending timer you own.

Firing: the pump tick claims due timers (`UPDATE ... SET status='fired' WHERE
status='pending' AND fire_at <= now() RETURNING *` — atomic across concurrent
pumps) and emits `timer.fired` with `dedupe_key = timer:<id>`. Resolution is
the pump interval (15s), which is plenty for minute-scale sleeps. Timers are
rows, so they survive restarts; a server that was down when a timer came due
fires it on the next tick — late, never lost.

`await_session`'s 1.5s status poll becomes legacy: the executor pattern
`spawn → sleep → digest` replaces it (§9). The tool stays for compatibility
and one-off scripting.

---

## 8. Child → parent questions

With parking in place, the missing half-duplex from the review costs one tool:

**`ask_parent(question, context?)`** — child emits `child.question` to its
parent and parks as `waiting`. The parent (woken by the event) answers with the
existing `spawn__append_message(child_id, answer)` — which already wakes parked
runs — and the child resumes with the answer as its next message. If the parent
never answers, the child's own watchdog applies: persona prompts pair every
`ask_parent` with a prior `timer__set`, so the child wakes, notes the silence,
and decides (proceed with stated assumption, or `raise` with
`code: "no_guidance"`). Roots with no parent get an error from `ask_parent`
telling them to ask the human (UI notification) instead.

---

## 9. The executor, rewritten as an event loop

Persona workflow (`lib/personas/executor.ts`) under this design:

```
1. list_tasks; build the dependency graph.
2. start_session for EVERY ready task. timer__set(45, "watchdog") once.
3. timer__sleep(30) — park.
4. On wake, read the <events> digest and dispatch on each event:
   - child.result (implementor, success) → start_review(task, pr_url)
   - child.result (reviewer)             → verdict approve? gh_pr__pr_merge
                                           : append_message(implementor, concerns)
                                             [attempt counter in task notes]
   - child.exception (recoverable)       → append_message(child, fix guidance)
   - child.exception / child.died (not)  → retry fresh once; then task → blocked + note
   - gh.pr.merged                        → task done arrives on its own; start
                                           newly-ready dependents
   - gh.ci.completed (failure)           → append_message(implementor, CI log pointer)
   - child.question                      → answer via append_message
   - budget.warning                      → stop spawning; drain what's running
   - timer.fired (watchdog)              → spawn__get_run each outstanding child;
                                           anything stalled → cancel + retry or block
5. Tasks outstanding? → arm watchdog, sleep again (goto 3).
   All done/blocked  → transition_plan, report_result, exit.
```

Attempt counters move from LLM memory into task notes (durable), so a replaced
executor resumes mid-plan: on its first turn it rebuilds state from
`list_tasks` + child runs (`parent_run_id` query) + notes — the review's
finding #4.

Between wakes the executor holds **no worker, no container, no tokens**. A
plan whose implementors take 40 minutes costs the executor a handful of short
turns instead of 40 minutes of pinned polling.

---

## 10. Failure matrix

The point of the design is that every stuck scenario from the original request
resolves to a row the machinery already knows how to handle:

| scenario | today | with events |
|---|---|---|
| Child dies (OOM/crash) | parent polls until `await_session` timeout | `handleWorkerDeath` emits `child.died` → parent wakes in seconds, decides re-dispatch vs blocked |
| Child completes, parent waits | 1.5s poll loop holding a worker | `child.result` wakes a parked parent |
| Parent dies mid-supervision | children's results never consumed | parent is parked, not mid-turn, most of the time — nothing to orphan; if it dies mid-turn, reaper reaps it and `child.*` events bubble past it to a live ancestor (§5.3) or surface at the root |
| Child broke, parent must instruct fix | works today (append_message) | unchanged — now triggered by `child.exception{recoverable}` instead of a timeout post-mortem |
| Child needs parent input mid-task | impossible (parent pinned; ancestor-append guarded) | `ask_parent` + park; parent answers via append |
| Wake itself is lost (crash between insert and dispatch) | n/a | durable state "parked + pending" re-swept by the pump every 15s |
| Event storm (CI fan-out) | n/a | dedupe keys + digest coalescing: one wake, one message |
| Both sides stuck waiting for each other | append-to-ancestor deadlock guards | parking removes held locks entirely; guards stay as belt |

One subtlety: resumable implement children legitimately reach `completed` more
than once (each `append_message` fix cycle re-completes). The terminal-event
dedupe is therefore per *turn-completion*, not per run — each resume that
reaches terminal emits a fresh `child.result` (the parent asked for the rework;
it wants the new result). The `terminal:<run_id>` singleton applies only to
`child.died` / `child.cancelled`.

## 11. Retention & observability

- Consumed inbox events are kept (they're the audit trail of *why* a parent
  acted) and GC'd with the run tree, via the existing cascade.
- A digest message in the transcript references event ids, so the UI can render
  "woken by: child.result #241, gh.ci.completed" on the run page — every wake
  is explainable.
- New runs list badge: parked status + pending-event count ("sleeping, 3
  events queued") makes a wedged wake visible at a glance.
- Metric worth logging from day one: wake latency (event `created_at` →
  turn start), which is the health number for the whole system.

## 12. Phasing

1. **Tables + emit.** `inbox_events`, `run_timers`, `emitInboxEvent()`, and
   producers: status transitions, `handleWorkerDeath`/reaper, webhook handler.
   Nothing consumes yet; verify volume/shape in the UI.
2. **Park + wake + digest.** `waiting`/`sleeping` statuses, reaper exemption,
   wake-on-insert, pump wake-sweep, turn-boundary digest injection,
   `timer__sleep` / `timer__set` / `events__poll`.
3. **Result contract.** `report_result` / `raise` / `ask_parent`, the
   `agent_runs.result` column, synthesized terminal events, persona updates.
4. **Executor v2** on the event loop; `await_session` marked legacy.
5. Later, if scale demands: `LISTEN/NOTIFY` to cut the 15s wake tail to
   near-zero — an optimization on the same rows, not a redesign.
