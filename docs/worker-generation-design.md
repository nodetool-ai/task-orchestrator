# Worker generations: race-free restart and resume

**Status:** Proposed  
**Scope:** detached worker dispatch, restart, resume, reconciliation, cancellation,
and the WebSocket worker channel  
**Motivating incident:** production run 195, 2026-09-08

## 1. Problem

The current runner model stores one mutable identity tuple per run:

```text
runner_instances(run_id, worker_scope, channel_instance_id,
                 controller_epoch, worker_incarnation, provider handle, ...)
```

That tuple represents several different lifetimes:

- the logical run, which survives many turns;
- the worker process, which may be restarted or replaced;
- the durable worker spool, which may survive a reconnect but not every process
  replacement;
- the controller connection, which may be taken over without replacing the
  worker process.

Mutating those identities in place creates intervals in which a new process is
compared with an old incarnation, or an old asynchronous observation can update
state belonging to a newer process.

Run 195 exposed one such interval:

1. Dispatch acquired a live server-process claim.
2. Sprite resume detected an old worker bundle, stopped the worker service,
   re-bootstrapped it, and restarted it.
3. The row still contained the previous worker incarnation.
4. Dispatch transferred `worker_scope` from its server claim to the stable
   Sprite handle before the new worker completed `channel.hello`.
5. The periodic reconciler observed a live Sprite with a different process
   incarnation, classified the run as `dead/replaced`, and returned the chat to
   `idle`.
6. The worker connected later, after the resumed turn had already been reaped.

Clearing `worker_incarnation` reduces this race but does not eliminate it. A
late hello or provider observation from the old connection can restore the old
value because the current persistence fence checks only the run and reused
channel instance.

The design needs one explicit answer to this question:

> Which worker process generation is allowed to mutate this run right now?

## 2. Decision

Add a monotonic **worker generation** to each runner instance and make it the
authority fence for every worker-originated or worker-targeted operation.

Use three separate identities:

| Identity | Lifetime | Changes when |
| --- | --- | --- |
| `run_id` | Logical conversation/task run | Never |
| `worker_generation` | One worker process/spool generation | The worker process is restarted, re-bootstrapped, or replaced |
| `controller_epoch` | One controller ownership lease within a worker generation | A controller reconnects or takes over the same live worker |

A worker generation also receives a fresh `channel_instance_id`. The instance
ID is the protocol/spool namespace; it is not the logical conversation ID.

This proposal uses a monotonic column on `runner_instances` rather than making
an immutable attempts table mandatory. An attempts table may be added later for
forensics. Correctness comes from comparing every mutation with the current
generation, not from retaining historical rows.

Do not reuse `agent_runs.attempt`: that field is the semantic rework generation
used by inbox-event deduplication. Worker process generations are independent
of agent rework attempts.

## 3. Invariants

The implementation must preserve all of these invariants.

### 3.1 Current-generation authority

Only frames and operations whose `(run_id, worker_generation,
channel_instance_id)` match the current `runner_instances` row may:

- append transcript or agent events;
- write checkpoints or SDK resume tokens;
- invoke tools or persist tool receipts;
- acknowledge commands;
- change run phase or status;
- park, finish, fail, or cancel a run;
- update worker incarnation or controller ownership.

The check and the resulting mutation happen in one database transaction under
the same runner-row or advisory lock. A check followed by an unguarded write is
not sufficient.

### 3.2 Monotonic generations

`worker_generation` only increases. A genuine process replacement atomically
increments it before external startup work begins. No code may reactivate an
older generation.

### 3.3 Reconnect is not restart

```text
same live process reconnects:
  same worker_generation
  same channel_instance_id and spool
  controller_epoch may increase

process restarts or is re-bootstrapped:
  new worker_generation
  new channel_instance_id and spool namespace
  controller_epoch begins a new lineage
```

Reusing an instance ID with an empty spool is unsafe. Worker receipts are
currently unique by `(run_id, instance_id, worker_seq)`; a fresh spool starts at
sequence 1 and would collide with receipts from the old process.

### 3.4 One provider operation per run

Stop, start, redefine, destroy, and adopt operations for one run are serialized.
A new generation is not launched until teardown of the old process is confirmed
or the provider proves it absent.

Whenever possible, provider process/service identities are generation-specific.
For Sprites, prefer service names such as `worker-g17` over a single mutable
`worker` service. A delayed stop for generation 16 can then never kill
generation 17.

Hard deletion of the whole Sprite remains run-scoped and is valid only after an
atomic terminal/cancelling transition that prevents future dispatch.

### 3.5 Boot remains observable

`allocating`, `booting`, and `connecting` are not exempt from reconciliation.
They are owned by an observable provisioning claim, currently represented by
`serverClaimScope`. A dispatcher crash must not leave a run permanently stuck.

### 3.6 Postgres is authoritative across generations

A new generation receives a newly composed `run.start` plus pending input from
Postgres. Pending commands from the old channel instance are not blindly
rebased into the new generation. The old spool and command lineage remain
historical evidence only.

## 4. Data model

### 4.1 Minimal required schema

Add these fields to `runner_instances`:

```text
worker_generation       INTEGER NOT NULL DEFAULT 1
generation_state        TEXT NOT NULL DEFAULT 'stopped'
provider_operation_id   UUID NULL
provider_service_name   TEXT NULL
```

`generation_state` has this vocabulary:

```text
allocating | booting | connecting | active | stopping | stopped | failed
```

Existing fields retain these meanings:

- `channel_instance_id`: current generation's protocol/spool namespace;
- `controller_epoch`: controller takeover sequence within the current
  generation;
- `controller_id`: current controller owner within the generation;
- `worker_incarnation`: provider-observed identity authenticated during the
  current generation's hello;
- `sprite_name`: stable run-level compute environment, not worker-process
  identity.

Add `worker_generation` to `worker_channel_commands` and
`worker_channel_receipts`. Their uniqueness constraints become:

```text
commands: (run_id, worker_generation, instance_id, controller_epoch, seq)
receipts: (run_id, worker_generation, instance_id, worker_seq)
```

The fresh `instance_id` already separates sequence spaces, but storing the
generation explicitly makes authority checks direct, prevents accidental
cross-generation queries, and improves incident forensics.

### 4.2 Optional history

An optional later `worker_generation_history` table can record:

```text
run_id, generation, instance_id, provider_handle, provider_service_name,
controller epochs, incarnation, lifecycle timestamps, terminal reason
```

It must not become the correctness mechanism. The current-generation compare on
`runner_instances` remains mandatory.

## 5. Protocol changes

Add `workerGeneration` to:

- worker service environment;
- `channel.hello`;
- `channel.accept`;
- every `WorkerEnvelope`;
- every controller command;
- durable command and receipt records.

The channel credential binds at least:

```text
run_id + worker_generation + channel_instance_id
```

Handshake acceptance requires all three to match the current runner row. A
stale worker receives a scope-mismatch rejection and cannot reach event or tool
handlers.

Controller epoch remains a narrower fence. It prevents an older controller
from commanding the same worker generation, but it must not be used as worker
process identity.

When observing hello incarnation, capture the accepted controller ID and epoch
by value before any asynchronous provider call. Persistence uses a guarded
write:

```sql
UPDATE runner_instances
   SET worker_incarnation = :observed
 WHERE run_id = :run_id
   AND worker_generation = :generation
   AND channel_instance_id = :instance_id
   AND controller_id = :controller_id
   AND controller_epoch = :captured_epoch;
```

Never read a mutable in-memory `this.epoch` after awaiting provider I/O and use
that newer value to authorize an older observation.

## 6. Lifecycle

### 6.1 Starting a new worker generation

The control plane performs the following state machine:

```text
stopped/failed/active-old
        │
        ▼
  allocate generation N+1 and fresh instance ID
        │
        ▼
  stop generation N and confirm teardown
        │
        ▼
  boot generation N+1 provider service
        │
        ▼
  connect and authenticate hello
        │
        ▼
  active
```

The initial allocation is an atomic database transaction:

1. Lock the run and runner row.
2. Verify the run is dispatchable and has no live provisioning owner.
3. Increment `worker_generation`.
4. Allocate a fresh `channel_instance_id`.
5. Set `generation_state = 'allocating'`.
6. Set a fresh observable server claim and `provider_operation_id`.
7. Clear generation-local controller and incarnation fields.
8. Commit.

External provider calls happen after this transaction. Their results are
accepted only while the same generation and operation ID remain current.

For a Sprite restart:

1. Stop the old generation-specific service.
2. Confirm it is stopped or absent.
3. Bootstrap/redefine as needed.
4. Create/start `worker-g<N>` using the new generation and instance ID.
5. Record the generation-specific provider service identity.
6. Connect the controller and send a newly composed authoritative `run.start`.

The server claim remains authoritative throughout allocation and boot. Do not
replace it with the stable Sprite name before the generation reaches an
authenticated connection state.

### 6.2 Same-process reconnect

A transient proxy or controller disconnect does not create a generation.

1. Inspect the provider and verify the stored incarnation is still present.
2. Retain generation, instance ID, and spool.
3. Stand down any retained local controller object.
4. Acquire a new controller epoch.
5. Reconnect and continue from durable command/receipt cursors.

The registry must honor an epoch bump even if it has a connected object cached.
`freshWorker` or takeover must replace/neutralize the old connection rather than
returning it unchanged.

### 6.3 Worker hello

Hello is accepted only for the current generation and instance. It atomically:

1. validates the generation-bound credential;
2. records controller ownership;
3. records or schedules the generation-fenced incarnation observation;
4. changes `connecting -> active`;
5. makes current-generation commands eligible for delivery.

An old hello is rejected without changing any row.

### 6.4 Turn completion and parking

`run.finished`, `run.failed`, `run.cancelled`, `run.park`, checkpoints, and
transcript appends carry the generation. The receipt insertion, current-
generation validation, and application mutation occur in the same transaction.

A stale terminal frame may be retained as diagnostic telemetry, but it cannot
change `agent_runs.status`, persist a result, or emit child completion.

Parking or finishing a turn does not itself create a new generation. If the
same process and spool survive, the next turn reconnects within the current
generation. If the provider service was restarted, the next turn allocates a
new generation.

### 6.5 Cancellation

Cancellation first locks the run and atomically:

1. changes it to `cancelling` or a hard terminal state;
2. captures the current generation and generation-specific provider identity;
3. prevents dispatch from allocating another generation.

It then sends `run.cancel` and/or stops only that captured generation. Final
cleanup is guarded by the same generation and must never clear ownership or
state belonging to a newer generation.

## 7. Reconciliation and crash recovery

Reconciliation reads the generation state, provisioning owner, and provider
observation together. Its policy is:

| State | Observation | Action |
| --- | --- | --- |
| allocating/booting/connecting | provisioning owner alive | Leave it alone |
| allocating | owner dead, no provider process | Mark generation failed; redispatch if policy permits |
| booting/connecting | owner dead, generation-specific process alive | Adopt it and attempt authenticated connection |
| booting/connecting | owner dead, process absent | Mark generation failed; redispatch if permitted |
| active | stored and observed incarnation agree | Alive |
| active | provider unknown | Leave it alone |
| active | provider absent or incarnation differs | Mark this generation dead and apply run recovery policy |
| stopping | old process still alive | Continue/redo idempotent generation-specific stop |
| stopping | old process absent | Mark stopped; allow queued dispatch if run remains eligible |

All decisions are followed by a compare-and-set on the same generation and
operation ID. Concurrent reconcilers may reach the same conclusion, but only
one may perform the state transition or claim the next provider operation.

Required dispatcher crash points are:

- after generation allocation but before provider start;
- after provider start but before storing its identity;
- after identity storage but before controller connection;
- after connection but before hello persistence;
- after hello but before `run.start` delivery.

Each point must converge through adoption, idempotent teardown, or one new
generation. None may remain permanently `preparing`, create two active workers,
or allow a stale worker to mutate the run.

## 8. Command, receipt, and tool semantics

### 8.1 New generation

Do not rebase arbitrary unacknowledged commands from an old instance. Build a
fresh authoritative snapshot from Postgres:

- current run/task/plan/persona/repository state;
- persisted transcript;
- pending user input;
- pending inbox digest;
- current policy and memory context.

The new spool starts its own sequence at 1 without colliding with old receipts.

### 8.2 Same-generation reconnect

Reconnect preserves the existing spool and uses current durable cursors.
Controller takeover may rebase pending commands to a new controller epoch only
within that same worker generation.

### 8.3 Tool side effects

Generation fencing prevents stale `tool.invoke` frames and stale tool results
from mutating current run state. It does not guarantee exactly-once external
side effects if the system crashes after a tool acts but before its result is
durably acknowledged.

Tools with external effects therefore need one of:

- an idempotency key derived from run, generation, and call ID;
- a transactional outbox with a durable execution/result record;
- an explicit at-least-once contract where duplication is safe and documented.

This is separate work and must not be claimed as solved by worker generations.

## 9. Provider requirements

The runner-provider interface should expose generation-aware operations:

```ts
type WorkerGenerationRef = {
  runId: number;
  generation: number;
  instanceId: string;
  providerHandle: string;
  processHandle: string;
  channelEndpoint: string;
};

startGeneration(input): Promise<WorkerGenerationRef>;
inspectGeneration(ref): Promise<alive | dead | unknown>;
stopGeneration(ref): Promise<void>;
```

`inspectGeneration` must observe a process/service identity, not merely the
stable Sprite. Seeing the Sprite alive is insufficient evidence that the
current worker generation is alive.

For Sprites:

- keep one stable Sprite per run;
- use a generation-specific supervised service name;
- stop and confirm the old service before binding the new service to port 8787;
- retain the repository and backend session files on the Sprite filesystem;
- use a fresh spool directory keyed by the new channel instance;
- delete obsolete generation services after they are confirmed stopped.

Providers that cannot offer generation-specific process handles must serialize
stop/start with a durable operation claim and confirm stop completion before
start. A fire-and-forget stop against a reusable handle is forbidden.

## 10. Migration and rollout

### Phase 1: Schema and observability

1. Add `worker_generation`, state, operation, and service-identity columns.
2. Backfill existing runner rows as generation 1.
3. Add generation to telemetry and diagnostic traces.
4. Keep protocol behavior compatible; do not enforce the new fence yet.

### Phase 2: Protocol compatibility

1. Teach new controllers and workers to send/accept generation fields.
2. Permit legacy connected workers only under an explicit generation-1
   compatibility path.
3. Prefer draining active workers before enforcement. If that is operationally
   practical, it is safer than maintaining a long-lived compatibility mode.

### Phase 3: Generation-fenced persistence

1. Add generation checks to handshake, event application, commands, receipts,
   checkpoints, tool invocation, terminal transitions, and incarnation writes.
2. Reject stale frames before handler execution.
3. Make receipt insertion and event application one transaction.

### Phase 4: Generation-aware provider lifecycle

1. Add fresh instance/spool allocation for real restarts.
2. Add generation-specific Sprite service names.
3. Serialize and confirm provider teardown/startup.
4. Implement boot adoption and reconciliation policies.

### Phase 5: Remove legacy behavior

1. Reject frames without generation.
2. Remove code that reuses a channel instance across process restarts.
3. Remove incarnation-clearing workarounds and any liveness rules made obsolete
   by explicit generation state.

Deploying strict protocol enforcement while legacy workers remain connected
will reject their frames and strand turns. Either drain them or deploy the
compatibility phase first.

## 11. Verification matrix

Tests should use deferred promises and controlled provider observations so each
ordering is deterministic.

### Stale worker fencing

- Old hello arrives after generation N+1 becomes current: rejected.
- Old incarnation observation finishes after reset: guarded write affects zero
  rows.
- Old observation finishes after the new observation: it cannot overwrite the
  new value.
- Old transcript, phase, checkpoint, park, finish, failure, and cancellation
  frames cannot mutate the current run.
- Old `tool.invoke` cannot execute a tool or create a current receipt.
- Old acknowledgement cannot acknowledge a new-generation command.

### Provider ordering

- Delayed stop for generation N cannot stop generation N+1.
- Sprite stale-bundle rebootstrap allocates a new generation and service.
- A new service is not started until the old service is confirmed stopped.
- Provider `unknown` does not reap an active generation.
- Provider absent or mismatched after active hello remains recoverable/reapable.

### Crash recovery

- Dispatcher crash at every boundary listed in section 7 converges.
- Two reconcilers can race but only one adopts, stops, or redispatches.
- Control-plane restart adopts a live connecting worker with the correct
  generation.
- Dead provisioning owner plus absent provider produces one replacement
  generation.

### Channel semantics

- Same-process reconnect retains generation, instance, spool cursor, and pending
  commands while increasing controller epoch.
- Real process restart gets a fresh instance; sequence 1 does not collide with
  old receipts.
- A cached connected controller is actually neutralized during takeover.
- New-generation `run.start` includes the latest persisted user input and inbox
  digest.
- Old unacknowledged commands are not replayed blindly into the new generation.

### Cancellation and terminal state

- Cancel racing generation allocation results in either no new generation or a
  generation that is immediately and specifically stopped, never a surviving
  worker on a terminal run.
- Terminal completion racing reconciliation is applied once for the current
  generation.
- Cleanup from an old generation cannot clear a newer claim.

### Migration

- A legacy connected worker is accepted only during the compatibility phase.
- A drained run resumes under generation 2 with a fresh instance.
- Mixed controller/worker versions fail closed with an actionable protocol
  error rather than silently losing a turn.

## 12. Non-goals

This design does not:

- make external tool side effects exactly once;
- change semantic `agent_runs.attempt` behavior;
- replace the run status state machine;
- require historical attempt rows;
- make provider `unknown` equivalent to dead;
- preserve an in-memory worker transcript across a true process restart.

## 13. Acceptance criteria

The design is complete when:

- every worker-originated mutation is fenced by current generation;
- process restart and same-process reconnect are distinct code paths;
- real restarts allocate a fresh protocol/spool instance;
- provider stop/start cannot cross generation boundaries;
- boot ownership is observable and recoverable;
- run 195's ordering no longer permits reconciliation to return the resumed run
  to idle before the new worker hello;
- the verification matrix passes for local and Sprites providers.
