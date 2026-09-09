# Event-driven run supervision

New runs use durable conversation delivery (`delivery_version = 2`). Starting a
child registers an attempt-scoped supervision subscription in the same
transaction as creation. Its questions and final outcome arrive in the parent's
conversation automatically. The parent can continue working or finish its current
response; it stays parked while supervision is outstanding and resumes on input.
There is no required `await_session` call.

For other runs in the same tree, use:

```ts
events__subscribe({
  source_run_id: 241,
  events: ["run.attempt_finished", "run.question_opened"],
  attempt: "current",
  replay: "current_state",
  lifetime: "attempt",
  keep_open: true,
  client_key: "review-241"
})
```

The call returns immediately with `subscription_id` and the subscription record.
Reuse the same client key and parameters to retry safely. `current` is resolved
once, so a retry does not accidentally observe a later attempt. Use a new key to
observe another attempt. `all` requires `until_unsubscribed` lifetime.
`events__list_subscriptions` lists interests; `events__unsubscribe` removes one.
Queued inputs remain unless `discard_pending: true`; executing inputs cannot be
retracted, and another matching subscription preserves its delivery.

Explicit subscriptions default to `keep_open: false`. Default child supervision
sets it to true. Self-subscriptions, cross-tree subscriptions, and cycles between
keep-open interests are rejected. Registration is capped at 100 active interests
per subscriber and 100 observers per source.

## Delivery and recovery

Source status/turn/question changes, immutable source facts, subscription matches,
and inbox deliveries commit together. Overlapping subscriptions produce one
recipient delivery. Materialization writes one typed `run_event` message and one
`run_inputs` row. Both the UI and backend consume that representation; event text
is attributed to its source and treated as quoted data.

The scheduler serializes logical turns, with up to 32 inputs per claim. Each has a
stable turn ID and ordered input manifest. A checkpoint must match the complete
manifest, logical attempt, and current execution generation before inputs are marked completed.
A new attempt supersedes unfinished turns from earlier attempts and cancels only
those turns' assigned inputs; pending corrective messages remain runnable.
Worker channel authentication additionally fences the instance and controller;
server turns check their worker-scope ownership. A replacement reuses an unfinished
manifest and records uncertain prior execution. External tool/model side effects
may repeat after an uncheckpointed crash; this is not exactly-once execution.

At each checkpoint the controller persists the next input command, a park/idle
instruction, or a terminal decision. Park and idle release the worker only after
the boundary is acknowledged. Cancellation and budget stops win over queued work.
A late finish cannot drop a queued input or an outstanding child. Implementation
workers defer final PR synchronization while supervising children.

Post-commit hints accelerate wakeup. The regular dispatch pump recovers missed
hints, missing message materialization, and failed dispatches. Its rotating cursor
prevents a repeatedly failing recipient from monopolizing the batch. Question
answers and deadline expiry share transactional source locks and an open-state
compare-and-set; timer firing and its inbox delivery also commit together.

## Compatibility and rollout

Migration `0041_run_event_subscriptions.sql` retains delivery version 1 on existing
runs and defaults newly inserted runs to version 2. Existing runs retain the
legacy parent-event route. Their wait interface stays available. On version 2,
`await_session` is a compatibility subscription alias, and `events__poll` is
read-only inspection, not acknowledgment.

Deploy the updated control plane and worker bundle together. Workers advertise
`run-input-receipts-v2`; the controller refuses a v2 bootstrap without it. No
historical inbox is blindly replayed into existing conversations. Source journal
foreign keys deliberately prevent deleting source history still referenced by
subscriptions or deliveries.

The initial implementation uses one short graph advisory lock before per-source
locks to serialize publication and observation-cycle changes safely. This is a
throughput tradeoff; no model or provider call executes while holding it.
`run.worker_failed` is a reserved subscription type; attempt failures are delivered
through `run.attempt_finished`. Infrastructure-specific diagnostic publication and
operational retention dashboards are separate extensions.

See [the design](run-event-subscriptions-design.md) for the broader architecture
and [MCP tools](mcp-server.md) for the tool catalogue. Regression coverage includes
three children supervised without waits, transaction rollback, overlapping
subscriptions, concurrent claims, partial/stale receipts, parked inbox-only wakeup,
failed dispatch retry, initial chat and task manifests, budget stops, late finish,
question expiry, and worker capability advertisement.
