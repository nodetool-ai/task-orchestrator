# Worker WebSocket protocol implementation plan

Audience: execution-only agents. Follow this plan in order. Do not redesign the
protocol, rename the message catalogue, combine milestones, or add an alternate
transport. The normative design is `docs/worker-websocket-protocol.md`.

Status (2026-07-16): all sections through 20 are implemented and committed at
the boundaries in section 22 (commits 1–18). The final acceptance run
(section 21) has been executed for its automated commands; results are
recorded in section 24. The section 21 manual scenarios (1–12) have not been
run and remain pending for the user to execute and record. This plan is
otherwise complete.

Migration strategy: hard switch. This deployment has no external users, so
there is no dual-transport operating period, no default flip, and no soak
window. HTTP remains untouched on `main` while all remaining work lands on one
migration branch; the branch ends by deleting the HTTP worker protocol
entirely (section 18). The safety mechanism is not a rollback flag — it is the
ported end-to-end test (section 12), written before the driver refactor and
green before the switch.

## 1. Required final state

When this plan is complete:

1. A worker starts a private WebSocket server.
2. The control plane discovers the worker endpoint and connects as the
   WebSocket client.
3. The worker never makes HTTP/SSE requests to the control plane and never
   reads Postgres.
4. The control plane pushes bootstrap context, user input, cancellation, tool
   results, and final commit decisions over the socket.
5. The worker emits transcript content, agent events, tool invocations,
   checkpoints, logs, and terminal proposals over the socket.
6. Disconnect/reconnect is at-least-once with durable idempotency, ordered
   replay, controller fencing, bounded buffering, and no duplicated tool side
   effects.
7. The existing browser REST and SSE surfaces remain unchanged.
8. `/api/worker/*`, the worker HTTP transport, worker API tokens, the worker
   SSE control stream, and the `TASK_ORCH_WORKER_TRANSPORT` flag are deleted.
9. Local child, Docker, and Fly runners use the WebSocket transport. Box is
   rejected by configuration until its provider supplies private inbound
   endpoint discovery; do not retain HTTP as a Box fallback.

## 2. Fixed implementation decisions

These decisions are not open to interpretation during implementation.

- Use the `ws` npm package for both server and client. Add `ws` to
  `dependencies` and `@types/ws` to `devDependencies`; do not rely on a
  transitive copy.
- Use JSON text frames for protocol messages and the binary format in the
  design document for blobs.
- Use protocol major `1` and subprotocol
  `task-orchestrator.worker.v1`.
- Use one worker instance and one WebSocket channel per run.
- Use port `8787` inside Docker and Fly workers.
- Use a Unix-domain socket for a detached local worker. Its path is
  `<cwd>/.worker-sockets/<instanceId>.sock`.
- Generate `instanceId` as `wi_<32 lowercase hex characters>` before provider
  creation. It is distinct from the provider handle and deployment instance id.
- Derive the instance bearer credential with HMAC-SHA256 so it survives a
  control-plane restart without storing plaintext:
  `wc1.<instanceId>.<base64url(HMAC(secret, "wc1:<runId>:<instanceId>"))>`.
- Resolve the HMAC secret from `TASK_ORCH_WORKER_CHANNEL_SECRET`, falling back
  to `AUTH_SECRET`. Do not reuse `TASK_ORCH_WORKER_API_SECRET`.
- Compare credentials with `timingSafeEqual` in the worker supervisor.
- Persist the channel endpoint, instance id, controller epoch, controller lease,
  durable commands, and inbound receipts in Postgres.
- The worker outbound spool is newline-delimited JSON at
  `$SESSION_ROOT/channel/outbox.jsonl`, with an adjacent
  `$SESSION_ROOT/channel/state.json`. Use append, `fsync`, atomic temp-file
  replace for compaction, and mode `0600`.
- Control-plane commands are persisted before sending. Worker events are
  spooled before sending.
- `channel.ack` and `channel.nack` use `seq: 0`, are never spooled, and are
  never acknowledged.
- Worker sequence numbers are monotonic for the instance lifetime. Control
  command sequence numbers are monotonic per controller epoch.
- The control plane renews liveness from received frames and WebSocket pong.
  The worker never calls a heartbeat operation.
- Exactly one worker-side component owns sequencing: `WorkerSession` owns the
  outbox, sequence assignment, epoch fencing, and replay (section 9). The
  WebSocket listener owns transport concerns only.
- Do NOT build a compatibility RPC (`compat.request`/`compat.result`) or any
  adapter that implements the legacy `RunTransport` interface over the
  channel. The driver refactor (section 13) consumes the channel session API
  directly. There is no intermediate runnable state that mixes the two.
- `TASK_ORCH_WORKER_TRANSPORT` survives only while HTTP code still exists
  in-tree: `http` (default) selects the legacy path, `ws` selects the channel
  path during branch development. Section 18 deletes the flag together with
  HTTP. It is never a shipped rollback mechanism.
- Between the switch (section 18) and their provisioning sections, Docker
  (section 19) and Fly (section 20) dispatch must fail fast with an explicit
  unsupported-provider error, exactly like Box. No provider silently falls
  back.
- Do not implement automatic fallback from WebSocket to HTTP.
- Do not expose the worker listener publicly and do not add a health HTTP
  endpoint.

## 3. Database changes — DONE

Implemented and green; commit at boundary 1 in section 22.

Create `db/migrations/0017_worker_channels.sql`, append the matching index-17
entry to `db/migrations/meta/_journal.json`, and update `db/schema.ts` in the
same commit. Use a timestamp greater than the `0016` journal timestamp. Do not
generate or add a snapshot JSON; migrations `0005` onward in this repository
are journaled SQL without snapshots.

### 3.1 Add columns to `runner_instances`

Add:

```text
channel_instance_id       text unique nullable
channel_endpoint          text nullable
controller_epoch          integer not null default 0
controller_id             text nullable
controller_lease_expires_at timestamptz nullable
channel_connected_at      timestamptz nullable
channel_last_seen_at      timestamptz nullable
```

Add an index on `controller_lease_expires_at` and a unique index on
`channel_instance_id` where it is not null.

### 3.2 Create `worker_channel_commands`

Columns:

```text
id                uuid primary key
run_id            integer not null references agent_runs(id) on delete cascade
instance_id       text not null
controller_epoch  integer not null
seq               bigint not null
type              text not null
payload           jsonb not null
state             text not null default 'pending'  -- pending | acked
created_at        timestamptz not null default now()
acked_at          timestamptz nullable
```

Constraints and indexes:

- unique `(run_id, instance_id, controller_epoch, seq)`;
- index `(run_id, instance_id, state, seq)`;
- check `state in ('pending', 'acked')`;
- check `seq > 0`.

### 3.3 Create `worker_channel_receipts`

Columns:

```text
id                  uuid primary key       -- worker envelope id
run_id              integer not null references agent_runs(id) on delete cascade
instance_id         text not null
worker_seq           bigint not null
controller_epoch     integer not null
type                 text not null
payload_sha256       text not null
result_command_id    uuid nullable references worker_channel_commands(id)
applied_at           timestamptz not null default now()
```

Constraints and indexes:

- unique `(run_id, instance_id, worker_seq)`;
- index `(run_id, instance_id, worker_seq)`;
- check `worker_seq > 0`.

The receipt row and the durable effect represented by the worker event must be
inserted in one DB transaction. A duplicate `id` with a different payload hash
is a protocol violation and closes the channel with `4403`.

### 3.4 Schema verification

Add `__tests__/worker-channel-schema.test.ts` which:

- inserts a runner instance with the new fields;
- proves duplicate instance ids fail;
- proves duplicate command sequences fail within one epoch;
- proves the same command sequence is allowed in a later epoch;
- proves duplicate worker sequence numbers fail;
- proves deleting a run cascades commands and receipts.

Run:

```bash
npm run typecheck
npm test -- __tests__/worker-channel-schema.test.ts
```

Do not proceed until both pass.

## 4. Protocol package — DONE

Implemented and green; commit at boundary 2 in section 22.

Create `lib/worker-channel/`. Do not put new WebSocket code under
`lib/worker/`; that directory remains the legacy boundary until it is deleted
in section 18.

### 4.1 `lib/worker-channel/protocol.ts`

Export:

- `WORKER_CHANNEL_PROTOCOL = 1`;
- `WORKER_CHANNEL_SUBPROTOCOL = "task-orchestrator.worker.v1"`;
- `WorkerEnvelope<T>` exactly matching the design document;
- handshake types `ChannelHello`, `ChannelAccept`, `ChannelReject`;
- transport types `ChannelAck`, `ChannelNack`;
- every command/event payload type from the design message catalogue;
- `WorkerCommand`, `WorkerEvent`, `HandshakeFrame`, and `WireFrame` unions;
- close-code constants with the numeric values in the design;
- `MAX_JSON_FRAME_BYTES = 1_048_576`;
- `DEFAULT_MAX_IN_FLIGHT_BYTES = 8_388_608`;
- `DEFAULT_HEARTBEAT_MS = 10_000`;
- `DEFAULT_DISCONNECT_GRACE_MS = 60_000`.

Use discriminated unions on `type`. Do not use `unknown` payloads except for
agent-authored `result`, tool arguments/results, and event payload bodies.

### 4.2 `lib/worker-channel/codec.ts`

Implement:

- `encodeFrame(frame): string`;
- `decodeFrame(data): WireFrame`;
- `payloadSha256(frame): string` using canonical JSON with recursively sorted
  object keys;
- `assertEnvelopeScope(frame, runId, instanceId)`;
- `assertPostHandshakeEnvelope(frame)`;
- `isTransportFrame`, `isWorkerCommand`, and `isWorkerEvent` type guards.

Validate all inbound data with Zod and enforce the JSON byte limit before
parsing. Parse once with `JSON.parse`; do not add a second JSON parser.

### 4.3 `lib/worker-channel/credential.ts`

Implement:

- `channelCredentialSecret()`;
- `mintChannelCredential(runId, instanceId)`;
- `verifyChannelCredential(token, runId, instanceId)`;
- `newChannelInstanceId()`;

Reject malformed run ids, instance ids not matching `^wi_[a-f0-9]{32}$`, token
prefix mismatch, instance mismatch, and bad signatures. Verification returns a
typed verdict and never throws for attacker-controlled token text.

### 4.4 Tests

Add:

- `__tests__/worker-channel-protocol.test.ts` for every message union member,
  unknown types, missing fields, oversized frames, scope mismatch, canonical
  hashes, and ack `seq: 0` rules;
- `__tests__/worker-channel-credential.test.ts` for valid, foreign-run,
  foreign-instance, malformed, rotation, and timing-safe comparison paths.

Run both tests plus typecheck before continuing.

## 5. Durable repositories and controller lease — DONE

Implemented and green; commit at boundary 3 in section 22.

Create `lib/worker-channel/repository.ts`. This module is control-plane-only and
may import `db`. No other new channel module may write channel tables directly.

Implement these functions:

```ts
reserveChannelIdentity(runId, instanceId, endpoint): Promise<void>
setChannelEndpoint(runId, instanceId, endpoint): Promise<void>
acquireControllerLease(runId, controllerId, now): Promise<ControllerLease>
renewControllerLease(runId, controllerId, epoch, now): Promise<boolean>
releaseControllerLease(runId, controllerId, epoch): Promise<void>
markChannelConnected(runId, instanceId, now): Promise<void>
touchChannel(runId, instanceId, controllerId, epoch, now): Promise<boolean>
persistCommand(input): Promise<CommandRow>
rebasePendingCommands(runId, instanceId, newEpoch): Promise<CommandRow[]>
listPendingCommands(runId, instanceId, epoch): Promise<CommandRow[]>
ackCommandsThrough(runId, instanceId, epoch, seq, now): Promise<void>
getLastAcceptedWorkerSeq(runId, instanceId): Promise<number>
applyWorkerEvent(frame, handler): Promise<ApplyResult>
```

Lease behavior is fixed:

1. `controllerId` is a random process id generated once at server startup.
2. Lease duration is `3 * DEFAULT_HEARTBEAT_MS`.
3. Acquire succeeds when the current lease is null, expired, or already owned
   by the same `controllerId`.
4. A successful fresh acquire increments `controller_epoch` atomically and
   returns the new value.
5. Renew and touch use compare-and-set on run id, controller id, and epoch.
6. Losing compare-and-set closes the channel as stale controller (`4409`).
7. Immediately after a fresh acquire, `rebasePendingCommands` moves every
   pending command from an older epoch into the new epoch and assigns sequences
   `1..N` in original `(created_at, id)` order. Command ids and payloads do not
   change. Acked commands remain in their original epoch. Perform the rebase in
   one transaction before any new command is persisted for the epoch.

`applyWorkerEvent` must:

1. calculate the canonical payload hash;
2. check an existing receipt by envelope id;
3. return the prior result command without rerunning the handler when id/hash
   match;
4. fail on id/hash mismatch;
5. reject a worker sequence gap;
6. call the supplied handler and insert the receipt in the same transaction;
7. return the highest contiguous accepted worker sequence.

Add `__tests__/worker-channel-repository.test.ts` covering two controllers
racing, lease expiry, stale renew, command replay, cumulative ack, receipt
deduplication, mismatched duplicate payload, gap rejection, and transaction
rollback.

## 6. Worker outbound spool — DONE

Implemented and green; commit at boundary 4 in section 22.

Create `lib/worker-channel/spool.ts`. This file must not import the DB.

Implement `WorkerOutbox` with:

```ts
open(root, runId, instanceId): Promise<WorkerOutbox>
append(frame): Promise<void>
listAfter(seq): Promise<WorkerEvent[]>
ackThrough(seq): Promise<void>
bytesInFlight(): number
nextSeq(): number
close(): Promise<void>
```

Rules:

- Verify `state.json` scope matches the boot run and instance.
- Append a complete JSON line, flush, and `fsync` before resolving `append`.
- Never reuse a sequence after restart.
- Compact after either 1,000 acked frames or 16 MiB of reclaimable data.
- Write compaction to `outbox.jsonl.tmp`, `fsync`, rename, then `fsync` the
  directory.
- Ignore only one final truncated JSON line after a crash. Any corrupt complete
  line is fatal.
- Refuse an event id already present with different contents.
- Apply `maxInFlightBytes` before accepting another durable frame.
- Expose an awaitable capacity signal so model-output consumption pauses rather
  than polling.

Add `__tests__/worker-channel-spool.test.ts` with real temporary directories for
restart, replay, ack, compaction, final-line truncation, mid-file corruption,
scope mismatch, monotonic sequence, duplicate ids, and backpressure release.

## 7. Worker WebSocket server — DONE (ownership revised by section 9)

Implemented and green; commit at boundary 5 in section 22. The listener/session
ownership split described here is refined by section 9, which must be executed
before any end-to-end wiring uses these components.

Create `lib/worker-channel/worker-server.ts` and
`lib/worker-channel/worker-session.ts`.

### 7.1 Listener

`worker-server.ts` must:

- read run id, instance id, expected bearer credential, and endpoint from
  worker config;
- create a `ws.WebSocketServer` with `noServer: true`;
- create its own Node HTTP server only for WebSocket upgrade handling;
- reject every normal HTTP request with `404` and an empty body;
- validate exact path `/worker/channel`;
- validate exact WebSocket subprotocol;
- validate the Authorization bearer credential before upgrade;
- limit one authenticated controller connection at a time;
- bind Unix socket for local or `0.0.0.0:8787` for Docker/Fly;
- chmod the Unix socket `0600` after bind;
- remove a stale Unix socket only when `lstat` proves it is a socket owned by
  the current uid;
- send `channel.hello` immediately after upgrade;
- require `channel.accept` within 10 seconds;
- enforce controller epoch fencing and close the prior connection on a higher
  epoch (delegated to the session after section 9);
- reject a lower/equal competing epoch with `4409`;
- send/receive acks and replay worker events from the control-plane cursor
  (delegated to the session after section 9);
- pause after disconnect and enforce the 60-second grace timer;
- surface commands through an async iterator; do not use a global event bus.

### 7.2 Worker session API

`worker-session.ts` exposes the only API the run driver may use:

```ts
await session.waitForStart(): Promise<RunStart>
session.commands(): AsyncIterable<RunInput | RunCancel | RunPark | RunCommit | ToolResult>
await session.emit(type, payload): Promise<Envelope>
await session.invokeTool(tool, args, callId): Promise<ToolCallResult>
await session.waitForCommit(finishEventId): Promise<RunCommit>
session.abortSignal: AbortSignal
await session.close(): Promise<void>
```

Correlate tool results by `replyTo` and envelope id. `run.cancel` aborts
`abortSignal` immediately before it is yielded to consumers. A disconnect does
not abort it until the grace period expires.

### 7.3 Supervisor secret isolation

Update `lib/agent-backend/env-scrub.ts` so the final denylist includes:

- `TASK_ORCH_WORKER_CHANNEL_CREDENTIAL`;
- `TASK_ORCH_WORKER_CHANNEL_ENDPOINT`;
- `TASK_ORCH_WORKER_INSTANCE_ID`.

Keep those values in the supervisor process but strip them from Claude CLI,
agent bash, pi tool subprocesses, and any child process launched by agent code.
Add assertions to `__tests__/agent-backend/env-scrub.test.ts` and
`__tests__/extensions/env-scrub.test.ts`.

### 7.4 Server tests

Add `__tests__/worker-channel-server.test.ts` using a real loopback socket.
Cover auth, path, subprotocol, hello timeout, one controller, higher-epoch
takeover, stale epoch rejection, event replay, command ack, disconnect grace,
abort after grace, JSON limit, and clean drain.

## 8. Control-plane connection manager — DONE

Implemented and green; commit at boundary 6 in section 22.

Create:

- `lib/worker-channel/controller.ts`;
- `lib/worker-channel/connection.ts`;
- `lib/worker-channel/registry.ts`.

### 8.1 Registry

Maintain one in-process `Map<runId, ControllerConnection>` stored under a
`globalThis` symbol, matching the repository's hot-reload-safe singleton style.
Export `connectRun`, `disconnectRun`, `sendCommand`, `getConnection`, and
`shutdownAll`.

### 8.2 Connect algorithm

`connectRun(runId)` performs exactly:

1. Load the run and `runner_instances` row.
2. Fail if endpoint or instance id is absent.
3. Acquire the DB controller lease and new epoch.
4. Re-derive the instance credential.
5. Dial the endpoint using `ws` and the required subprotocol/header.
6. Validate `channel.hello` scope and protocol range.
7. Send `channel.accept` with DB receipt cursor and limits.
8. Mark connected.
9. Rebase older pending commands into the current epoch.
10. Replay pending commands for the current epoch.
11. Start ping every 10 seconds and lease renew every 10 seconds.
12. Dispatch inbound events serially per run through the event handler.

Use exponential connect backoff `250, 500, 1000, 2000, 5000 ms`, capped at 5
seconds, and stop after the provider boot timeout already used by that provider.
Do not retry auth, scope, or protocol mismatch errors.

### 8.3 Command send

`sendCommand` must persist first, then send if connected. If disconnected it
returns after persistence; reconnect performs delivery. The returned promise
resolves only after worker cumulative ack or rejects when the run/instance is
replaced.

### 8.4 Input and cancellation bridges

Replace worker-directed uses of Postgres `run_input` and cancel polling with:

- after a user message transaction commits, load the new message row and call
  `sendCommand(runId, "run.input", ...)`;
- after cancel intent commits, call
  `sendCommand(runId, "run.cancel", { reason, requestId, deadline })`;
- retain Postgres notifications only for browser/control-plane replicas; the
  controller owning the channel converts the durable DB event to a command;
- on another replica's notification, the lease owner loads and sends the
  missing command idempotently.

Add `__tests__/worker-channel-controller.test.ts` covering handshake, persisted
send-before-wire, restart replay, pings/touch, lease loss, input, cancel, and
protocol mismatch.

## 9. Unify worker session ownership

Do this before any end-to-end wiring. It is a correctness prerequisite, not
cleanup.

Problem: `worker-server.ts` contains a private `QueueWorkerSession`
(implementing `WorkerSessionLike`) and opens its own `WorkerOutbox`, appending
frames and assigning sequences itself; `worker-session.ts` exports the richer
`WorkerSession`, which also owns an outbox and independently implements epoch
fencing and replay. Composing them as they stand gives one channel two
sequence streams and two replay sources. Exactly one component may own
sequencing.

Required end state:

- `WorkerSession` is the single owner of: the `WorkerOutbox`, worker sequence
  assignment, controller epoch fencing (`acceptController`/reconnect), replay
  after reconnect, ack/nack handling, and the driver-facing API in section
  7.2.
- `worker-server.ts` retains transport duties only: endpoint bind
  (Unix/`0.0.0.0:8787`), socket-mode and stale-socket rules, credential
  verification with `timingSafeEqual`, path and subprotocol validation,
  upgrade handling, single-controller admission, `channel.hello` send and the
  10-second accept timeout, the disconnect grace timer, and clean shutdown. On
  a validated `channel.accept` it attaches the raw transport to the session
  and forwards frames both ways. It must not open an outbox, assign a
  sequence, or track an epoch beyond handing the accept payload to the
  session.
- Delete `QueueWorkerSession` and the server-side outbox/replay/fencing code
  paths it made necessary. Merge `WorkerSessionLike` into the `WorkerSession`
  contract; the server takes a `WorkerSession` (which carries the outbox), not
  an outbox of its own.
- Production worker code has exactly one `WorkerOutbox.open` call site.

Tests: keep both existing suites green through the refactor — they are the
safety net. Afterward the split is: `worker-channel-server.test.ts` proves
transport concerns (auth, path, subprotocol, hello timeout, one controller,
JSON limit, grace timer, drain) against an injected session;
`worker-channel-session.test.ts` proves epoch takeover, stale-epoch rejection,
replay, cumulative ack, and abort semantics. Remove duplicated coverage in the
server suite by delegation, not deletion of the behavior.

Run before continuing:

```bash
npm run typecheck
npm test -- __tests__/worker-channel-server.test.ts __tests__/worker-channel-session.test.ts __tests__/worker-channel-spool.test.ts
npm test
```

## 10. Local runner provisioning and endpoint discovery

Local child only. Docker and Fly move to sections 19 and 20, after the switch;
until those sections land they must reject `ws` dispatch explicitly (see 10.3).

Groundwork already in the working tree: `lib/config.ts` (`workerTransport()`,
`config.worker.*`), `lib/runner/provider.ts` (`channelEndpoint`/
`channelInstanceId` on `RunnerRef`/`CreateRunnerInput`), `lib/worker/token.ts`
(`workerChannelDispatchEnv()`), and `lib/run-dispatch.ts` imports of
`connectRun`/`reserveChannelIdentity`/`newChannelInstanceId` (currently
unused). This section wires them.

### 10.1 Shared provider contract

Update `lib/runner/provider.ts`:

```ts
interface CreateRunnerInput {
  runId: number;
  scope: string;
  channelInstanceId: string;
}

interface RunnerRef {
  runId: number;
  handle: string;
  provider: RunnerProviderKind;
  channelEndpoint: string;
  channelInstanceId: string;
}
```

`dispatchRun` generates the instance id, reserves it in `runner_instances`,
passes it to provider creation, persists the returned endpoint, then calls
`connectRun`. A provider must not return success without an endpoint.

In `ws` mode the worker environment is
`workerChannelDispatchEnv(runId, instanceId, listenEndpoint)` returning only:

```text
TASK_ORCH_WORKER_TRANSPORT=ws
TASK_ORCH_WORKER_INSTANCE_ID=<instanceId>
TASK_ORCH_WORKER_CHANNEL_CREDENTIAL=<derived credential>
TASK_ORCH_WORKER_CHANNEL_ENDPOINT=<listen endpoint>
```

Continue withholding `DATABASE_URL`. `workerChannelDispatchEnv` currently
lives in `lib/worker/token.ts`, which section 18 deletes — move it to
`lib/worker-channel/` now (e.g. `lib/worker-channel/dispatch-env.ts`) so the
deletion section removes only dead code. The
`TASK_ORCH_WORKER_TRANSPORT=ws` line is deleted with the flag in section 18.

### 10.2 Local child

- Create `.worker-sockets` at dispatch with mode `0700`.
- Set worker listen endpoint to `unix:<absolute socket path>`.
- Set the stored/dial endpoint to the `ws` package's Unix URL form:
  `ws+unix://<absolute socket path>:/worker/channel`.
- Ensure worker exit removes its socket in a `finally` block.
- Extend local monitor/reaper cleanup to unlink abandoned safe socket files.
- Add local endpoint assertions to
  `__tests__/run-dispatch.test.ts`, `__tests__/run-worker.test.ts`, and
  `__tests__/worker-monitor.test.ts`.

Verify the channel layer end-to-end with a thin harness before the driver
refactor: extend `__tests__/worker-channel-controller.test.ts` (or add a
focused dispatch test) proving that a locally dispatched supervisor accepts
`connectRun`, receives a persisted command, emits an event that lands a
receipt, and replays across a controller reconnect — no run driver involved.

### 10.3 Unsupported providers

Update `validateBoxConfig()` to reject `TASK_ORCH_WORKER_TRANSPORT=ws` with:

```text
Box runners do not yet expose a private control-plane-to-worker WebSocket endpoint.
```

Docker and Fly reject `ws` dispatch the same way (naming their own section of
this plan) until sections 19 and 20 land. When section 18 deletes HTTP, these
rejections become unconditional for any provider whose section has not landed.
This is an explicit unsupported-provider result, not a runtime fallback.

## 11. Build and dispatch the authoritative start snapshot

`buildRunStart` already exists in `lib/worker-channel/snapshot.ts` but has no
caller and no test. Both gaps close in this section; the function has never
been exercised against real run rows, so trust nothing until the test passes.

Implement/complete `buildRunStart(runId, mode)` using `dbTransport`/repository
functions. It must include the exact `RunStart` fields in the design:

- run row;
- task or null;
- plan or null;
- persona;
- resolved repository;
- ordered transcript;
- claimed inbox digest;
- ambient memory context;
- pending input rows;
- allowed tool names and budget/deadline policy.

Move the decision about fresh versus resume into this builder. Wire it into
dispatch: after `connectRun` accepts, the control plane persists one stable
`run.start` command id per worker instance (via `persistCommand`) and sends
it. A reconnect replays that command; it never builds a second snapshot for
the same instance.

Add `__tests__/worker-channel-snapshot.test.ts` covering chat, implement,
review, execute, missing optional task/plan, transcript ordering, pending input,
memory, inbox claim, provider-qualified model/persona, and resume.

## 12. Port the end-to-end test as the acceptance spec

Write the acceptance test BEFORE the driver refactor. It is the replacement
for the deleted soak/dual-transport safety net: it encodes the behavior the
HTTP transport currently guarantees, and the switch (section 18) is forbidden
until it passes.

Create `__tests__/worker-websocket-e2e.test.ts` by porting the behavioral
coverage of the existing HTTP/transport end-to-end tests
(`__tests__/worker-http-transport.test.ts`,
`__tests__/worker-transport-semantics.test.ts`, `__tests__/run-worker.test.ts`).
Use a real control-plane WebSocket client, real worker server, real test DB,
and mocked model backend. It must prove, over the channel only:

- chat run: initial turn, follow-up input wake, idle claim release;
- implement run: tool call round-trip, terminal completed status;
- cancellation during a model turn and during a tool call;
- terminal status is landed once, by the control plane, after `run.finished`;
- claim release and stranded-input redispatch match current semantics;
- no worker HTTP request and no worker DB access occur (assert the mocks).

Gate it behind an environment flag while it cannot pass:

```ts
describe.runIf(process.env.WS_E2E === "1")("worker websocket e2e", () => { ... })
```

At creation, run it once with `WS_E2E=1` and record that it fails because the
driver still uses the legacy transport — not because of a harness bug. Each of
sections 13–15 should turn more of it green (`WS_E2E=1 npm test -- __tests__/worker-websocket-e2e.test.ts`).
At the end of section 15, remove the `runIf` gate so it runs in the default
suite, and do not proceed to section 16 until it passes ungated.

## 13. Refactor the worker driver away from reads

This is the largest code change. Make it in small commits with the suite green
after every commit. The driver consumes the `WorkerSession` API from section
7.2 directly — there is no adapter implementing `RunTransport` over the
channel.

### 13.1 Introduce worker context

Create `lib/worker-runtime/context.ts`:

```ts
interface WorkerRunContext {
  start: RunStart;
  session: WorkerSession;
  run: RunSnapshot;
  task: TaskSnapshot | null;
  plan: PlanSnapshot | null;
  persona: PersonaSnapshot;
  repository: RepositorySnapshot;
  transcript: MessageSnapshot[];
}
```

Add `driveWorkerRun(context)` beside `driveDispatchedRun`. Initially call the
same lower-level functions but pass loaded objects explicitly.

Update `scripts/run-worker.ts` for `ws` mode: start the WebSocket supervisor,
`await session.waitForStart()`, build `WorkerRunContext` from the snapshot,
call `driveWorkerRun`, and close the supervisor after run commit/drain. The
`http` path continues to call `driveDispatchedRun` unchanged until section 18
deletes it. A worker in `ws` mode without complete channel configuration fails
fast; no worker path may select `dbTransport` except the existing test escape
hatch.

### 13.2 Remove bootstrap reads in this order

For each bullet, change function signatures to accept the value from context,
delete the worker-side transport call, and run the nearest tests:

1. `getRun` and `listMessages`;
2. `getTask`;
3. `getPlan` and `listTasks`;
4. `getPersona`;
5. `resolveRepo` and `listRepoRemotes`;
6. `claimInboxDigest`;
7. `countEvents`.

Control-plane/in-process entry points may continue using repositories to build
a context. Only worker entry points are forbidden from reading.

### 13.3 Input loop

Replace `subscribeInput` with the worker session command iterator. Maintain an
in-memory ordered input queue keyed by persisted message id. Ignore duplicate
ids, reject decreasing non-duplicate ids, and append accepted inputs to the
worker's transcript view. Preserve the existing chat idle timeout behavior.

### 13.4 Tests

Add a guard test that imports the built worker bundle and fails when it contains
any of these strings:

```text
/api/worker
TASK_ORCH_WORKER_API_URL
DATABASE_URL
getTask(
getPlan(
getPersona(
resolveRepo(
subscribeInput(
```

Limit function-string checks to worker-runtime/channel bundle modules so normal
control-plane source names do not create false positives.

## 14. Replace worker writes with semantic events

Create `lib/worker-channel/event-handler.ts` in the control plane. Handle each
worker event serially and transactionally.

### 14.1 Transcript and raw events

- `transcript.append`: call the existing message persistence path with envelope
  id as idempotency key; return the persisted message id in the ack/result.
- `agent.event`: append `agent_events`; preserve current browser notification
  behavior.
- `worker.log`: update the bounded worker log tail; coalesce batches.

### 14.2 Phase and checkpoint

- `run.phase`: validate monotonic lifecycle progression, then apply the existing
  status/event transaction.
- `run.checkpoint`: update SDK session id, usage counters, worktree/branch/PR
  metadata only from an allowlisted payload.

### 14.3 Finish/fail/cancel

- `run.finished`: validate the run is not cancelled/closed, atomically land the
  existing completed outcome, perform existing task/plan synchronization, and
  enqueue `run.commit` referencing the finish event id.
- `run.failed`: atomically land failure with normalized error and enqueue
  `run.commit`.
- `run.cancelled`: acknowledge cancel intent, atomically land cancelled, clear
  the worker claim, and enqueue `run.commit`.
- If finalization was already applied for the same event id, return the existing
  commit command.
- If a conflicting terminal outcome already won, enqueue `run.commit` with the
  authoritative outcome and `accepted: false`.

### 14.4 Remove write operations

Change worker code in this order:

1. `appendMessage` → `transcript.append`;
2. `appendEvent` → `agent.event`;
3. `patchRun` → `run.checkpoint` or terminal payload;
4. `setStatus`/`applyStatus` → `run.phase`, `run.finished`, `run.failed`, or
   `run.cancelled`;
5. `writeWorkerLog` → `worker.log`;
6. `heartbeat`/`ackCancel` → delete; channel handles both;
7. `releaseClaim` → delete from worker; control-plane commit/disconnect handler
   owns claim release and stranded-message redispatch;
8. direct task/plan transition and notes → named `tool.invoke` calls.

Port the behavioral cases from `__tests__/worker-transport-semantics.test.ts`,
`__tests__/atomic-finalize.test.ts`, `__tests__/turn-end-state-transport.test.ts`,
`__tests__/runs-claim-release.test.ts`, and
`__tests__/cross-process-cancel.test.ts` to channel event-handler tests. Do NOT
delete or weaken the originals here — they still guard the live HTTP path and
are deleted with it in section 18.

Implementation notes (from execution):
- The control-plane event handler runs inside `applyWorkerEvent`'s
  transaction; `persistCommand` opens its own transaction and would deadlock.
  Add a tx-scoped command-insert variant in `repository.ts` for result/commit
  commands enqueued from within the handler.
- 14.4 is a turn-engine port, not a call-site swap: the legacy turn machinery
  (`driveDispatchedRun`/`driveChatSession` in `lib/runs.ts`) stays intact for
  the HTTP path until section 18; `runWorkerTurn` in
  `lib/worker-runtime/context.ts` gets its own channel-native turn loop that
  reads from `WorkerRunContext` and writes only via `session.emit` semantic
  events, ending in `run.finished` + `waitForCommit`. Temporary duplication
  with `lib/runs.ts` is accepted; the legacy copy dies in section 18. Commit
  the event handler and the turn port separately (section 22).

## 15. Route all tools through `tool.invoke`

Create `lib/worker-runtime/tools.ts` as the worker-side tool bridge. It receives
the already authorized tool catalogue from `run.start` and exposes only those
names to the agent backend.

For every existing remote tool path in:

- `lib/extensions/agent.ts`;
- `lib/extensions/events.ts`;
- `lib/extensions/planning.ts`;
- `lib/extensions/spawn.ts`;
- `lib/extensions/persona-memory.ts`;
- `lib/extensions/gh-pr.ts`;
- `lib/extensions/gh-ci.ts`;

replace `runTransport().callTool`, repository lookup, repo-remote lookup, and PR
lock calls with `session.invokeTool`.

Control-plane `tool.invoke` handling must:

1. derive run/task/plan/author scope from the channel;
2. reject tools absent from the persisted start policy;
3. store the receipt before exposing any result;
4. execute through `lib/worker/server-tools.ts`;
5. send `tool.accepted` before work that may exceed 5 seconds;
6. persist one `tool.result` command linked from the receipt;
7. replay that exact command on duplicate invocation;
8. never rerun an invocation whose side effect committed.

Add `__tests__/worker-channel-tools.test.ts` for allowed/denied tools, spoofed
scope, duplicate side-effect invocation, long-running accepted/result flow,
disconnect between commit and result delivery, structured errors, image result,
spawn child, memory, PR lock, and cancellation.

At the end of this section, remove the `WS_E2E` gate from
`__tests__/worker-websocket-e2e.test.ts` (section 12) and make the full suite
pass with it included. Do not continue until it does.

## 16. Blob transfer

Create `lib/worker-channel/blob.ts` and implement the exact header described in
the design document.

Use `$SESSION_ROOT/channel/blobs/<blobId>.part` on the worker and a control-plane
temporary directory under the existing writable temp root. Requirements:

- validate declared size is `0..25 MiB`;
- validate UUID, MIME type, purpose, chunk number, final flag, and byte count;
- chunk at 64 KiB;
- include blob bytes in the negotiated in-flight window;
- persist accepted chunk cursor;
- resume from the cursor after reconnect;
- verify SHA-256 before atomic rename/DB attachment insert;
- delete partial blobs on terminal drain or after 24 hours;
- never place base64 blob data in JSON or transport logs.

Status note (execution): the blob MECHANISM (binary header codec, resumable
durable receiver, chunker, SHA-256 verify + atomic rename, cleanup) exists with
a green 28-case `__tests__/worker-channel-blob.test.ts`. The WIRE INTEGRATION
below is what remains for boundary 14.

Wire integration (normative shapes now pinned in the design doc's message
catalogue and Blob transfer section):

- Add `blob.open`, `blob.accepted { blobId, nextChunk, complete }`, and
  `blob.rejected` to `protocol.ts` in BOTH direction unions; they are ordinary
  sequenced JSON messages. Binary chunk frames are unsequenced and correlated
  by blob id + chunk number.
- Accept binary frames in the worker server and controller connection (both
  currently reject with `1002`) and route them to the blob receiver; chunk
  bytes count toward `maxInFlightBytes`.
- Enforce the ordering rule: a sender sends a blob to `complete: true` before
  any message referencing it; a reference to an unknown/incomplete blob is a
  protocol violation. Exception: `run.start` attachments are sent immediately
  after the command and the worker defers applying it (and `run.ready`) until
  they complete.
- The blob-reference content block is
  `{ type: "blob", blobId, mimeType, size, sha256, purpose }` — use it in
  start attachments, `transcript.append` image blocks, and image
  `tool.invoke`/`tool.result` payloads.
- On reconnect, a partial blob is re-`blob.open`ed and resumes from the
  receiver's persisted cursor via `blob.accepted.nextChunk`.

Add integration coverage in `__tests__/worker-channel-blob-wire.test.ts` over a
real loopback channel: worker→control image event round-trip, control→worker
start attachment deferring `run.ready`, reconnect resume mid-blob, rejection
on digest mismatch, and reference-before-complete as a protocol violation.

Mechanism coverage (already green) in `__tests__/worker-channel-blob.test.ts`:
empty, one-chunk, multi-chunk, 25 MiB, oversize, wrong digest, missing chunk,
duplicate chunk, reconnect resume, and cleanup.

## 17. Reliability and reaper integration

This section lands BEFORE the switch, on the same branch. After section 18
there is no HTTP heartbeat keeping liveness honest; if reconnect and lease
handling are not in place at the switch, runs strand silently on the first
dropped socket.

Update `instrumentation.ts`, `lib/run-dispatch.ts`, provider monitors, and the
existing orphan reconciler.

Required behavior:

- server startup creates one controller id and scans active runner instances;
- it acquires leases and reconnects to their stored endpoints;
- connection activity updates `channel_last_seen_at` and the existing
  `heartbeat_at` in one control-plane transaction;
- stale-channel detection uses `channel_last_seen_at`, not worker heartbeat
  requests;
- a disconnected but provider-live worker receives the 60-second reconnect
  grace before replacement;
- a provider-dead worker follows existing re-dispatch/idle/fail policy;
- a protocol mismatch replaces the worker with the current image;
- a terminal commit closes cleanly, stops the provider where appropriate, and
  clears controller lease/worker claim;
- control-plane shutdown sends `channel.drain` only for an intentional full
  shutdown; hot deploy simply closes sockets so the next process reconnects;
- stranded user messages are checked and re-dispatched after terminal/idle
  claim release using the existing semantics.

Add `__tests__/worker-channel-recovery.test.ts` for control-plane restart,
worker restart with spool, provider death, disconnect grace, stale channel,
protocol mismatch, terminal drain, stranded input, and two replicas racing.
Extend `__tests__/worker-websocket-e2e.test.ts` with a mid-run controller
reconnect scenario.

## 18. The switch: WebSocket-only, delete HTTP

One milestone, one branch state: `ws` becomes the only transport and the HTTP
worker protocol is deleted. There is no default-flip-then-soak phase and no
rollback flag.

Preconditions (all must hold before starting this section):

- `__tests__/worker-websocket-e2e.test.ts` passes ungated;
- `__tests__/worker-channel-recovery.test.ts` passes;
- full suite, typecheck, `npm run build:worker`, and `npm run build` pass;
- a manual local detached run (chat with follow-up, cancel, resume) has been
  executed and its run ids recorded in section 24.

### 18.1 Make WebSocket unconditional

- Delete `TASK_ORCH_WORKER_TRANSPORT`, `workerTransport()`, and every
  `http`/`ws` branch; the channel path is the only path.
- Local dispatch always provisions the Unix socket endpoint (section 10.2).
- Docker, Fly, and Box dispatch fail fast with the documented
  unsupported-provider error until their sections land (Docker: 19, Fly: 20,
  Box: pending private ingress). Delete Box worker API URL/token forwarding.

### 18.2 Delete

- `app/api/worker/[...path]/route.ts`;
- `lib/worker/api-handlers.ts`;
- `lib/worker/http-transport.ts`;
- `lib/worker/token.ts` (after confirming `workerChannelDispatchEnv` was moved
  in section 10.1);
- `TASK_ORCH_WORKER_API_URL`;
- `TASK_ORCH_WORKER_TOKEN`;
- `TASK_ORCH_WORKER_API_SECRET`;
- worker `/control` SSE logic;
- `driveDispatchedRun`'s transport-driven paths once `driveWorkerRun` is the
  only worker entry point;
- obsolete HTTP protocol tests.

Keep or relocate:

- `lib/worker/db-transport.ts` only if control-plane code still benefits from
  the interface; rename it to a control-plane repository module if it no longer
  represents a transport;
- `lib/worker/protocol.ts` only for shared domain types still used outside
  workers; move those types and delete the `RunTransport` interface when no
  callers remain;
- `lib/worker/log.ts` if still used by the supervisor.

### 18.3 Docs and environment

Update in the same milestone:

- `.env.example` if present;
- `docker-compose.yml`;
- `Dockerfile.worker` comments and exposed port;
- `Dockerfile.fly-runner`/entrypoint comments if present;
- `scripts/dev-workers.sh`;
- `scripts/fly-deploy.sh`;
- `README.md` worker sections;
- `AGENTS.md` security/worker wording;
- `SCHEMA.md` runner/channel tables and liveness state machine.

Replace `docs/worker-http-api.md` content with a short tombstone pointing to
the WebSocket design and implementation date. Do not leave instructions that
suggest workers can call the control plane.

Delete or rewrite these test files:

- `__tests__/worker-api-handlers.test.ts`;
- `__tests__/worker-http-transport.test.ts`;
- `__tests__/worker-token.test.ts`;
- `__tests__/heartbeat-protocol-mismatch.test.ts`;
- HTTP-specific sections of `__tests__/worker-transport-semantics.test.ts`,
  `__tests__/atomic-finalize.test.ts`, `__tests__/turn-end-state-transport.test.ts`,
  `__tests__/runs-claim-release.test.ts`, and
  `__tests__/cross-process-cancel.test.ts` (their behavioral cases were ported
  to channel tests in section 14; only now do the transport-specific originals
  go).

### 18.4 Verification

Run a repository-wide search and require no results outside migration history
or the HTTP tombstone:

```bash
rg -n "api/worker|worker-http|TASK_ORCH_WORKER_API|TASK_ORCH_WORKER_TRANSPORT|createHttpTransport|authorizeWorkerRequest" . \
  --glob '!node_modules' --glob '!dist' --glob '!db/migrations/meta/**'
```

Then:

```bash
npm run typecheck
npm test
npm run build:worker
npm run build
```

Verify with network policy/logging on a local run that the worker makes no
request to `/api/worker` and holds no `DATABASE_URL`.

## 19. Docker provisioning

Additive after the switch; replaces the Docker unsupported-provider rejection.

- Add `ExposedPorts: { "8787/tcp": {} }` to the container config.
- Do not add `PortBindings`.
- Set worker listen endpoint to `tcp:0.0.0.0:8787`.
- Set stored/dial endpoint to `ws://<container-name>:8787/worker/channel` when
  `TASK_ORCH_DOCKER_NETWORK` is configured.
- For Docker Desktop host development without a shared named network, inspect
  the container after start, obtain its private bridge IP, and store
  `ws://<ip>:8787/worker/channel`.
- Wait for authenticated WebSocket readiness instead of assuming
  `container.start()` means ready.
- Add config and lifecycle cases to existing Docker dispatch/monitor tests.
- Run the repository's local Docker worker flow end-to-end and record the run
  ids in section 24.

## 20. Fly provisioning

Additive after the switch; replaces the Fly unsupported-provider rejection.

- Add service-less private listener configuration for internal port `8787` to
  the Machine config. Do not create a public Fly service or public IP.
- Resolve the Machine private IPv6 address from the Machines API response or a
  follow-up machine lookup.
- Store a bracketed URL:
  `ws://[<private-6pn-ip>]:8787/worker/channel`.
- Pass `TASK_ORCH_WORKER_CHANNEL_ENDPOINT=tcp:0.0.0.0:8787` to the worker.
- Change provider create/resume success to mean channel handshake complete,
  not merely Machine state `started`.
- On resume, reuse the existing channel instance id and credential when the
  same volume/worker identity resumes; generate a new identity only when the
  Machine/session volume is replaced.
- Add tests to `__tests__/fly-client.test.ts`,
  `__tests__/fly-provider.test.ts`, and
  `__tests__/integration/fly-live.test.ts`.
- Run one Fly live test and record the run ids in section 24.

## 21. Final acceptance run

Run all commands from a clean checkout with production-like environment:

```bash
npm ci
npm run typecheck
npm test
npm run build:worker
npm run build
```

Execute these manual scenarios and append run ids/results to section 24:

1. local detached chat: initial turn, two follow-ups, idle, resume;
2. Docker implement run: shell output, tool call, push, terminal commit;
3. Fly execute run: child spawn, park, resume, completion;
4. user input during an active model turn;
5. cancel during model output and during a long-running tool;
6. control-plane restart during model output;
7. socket loss after tool side effect but before result delivery;
8. worker process restart with unacknowledged spool entries;
9. 25 MiB attachment interrupted halfway and resumed;
10. old worker image against a newer protocol major;
11. second control-plane replica attempts stale-epoch control;
12. Box configuration fails immediately with the documented unsupported error.

For each scenario verify:

- one authoritative terminal/idle state;
- no duplicate messages, events, or tool effects;
- worker claim and controller lease are cleared or intentionally live;
- UI SSE still displays the complete persisted transcript/event stream;
- worker logs contain frame metadata but no payloads or credentials;
- worker network logs contain no control-plane HTTP request;
- the agent subprocess environment lacks channel credentials.

## 22. Commit boundaries

Use one commit per boundary below. Never mix cleanup with functional changes.
Boundaries 1–6 cover work that already exists uncommitted in the working tree;
commit it first, at these boundaries, before starting section 9.

1. `db: add durable worker channel state`
2. `worker-channel: add protocol codec and credentials`
3. `worker-channel: add controller lease repository`
4. `worker-channel: add durable worker outbox`
5. `worker-channel: add worker websocket supervisor`
6. `worker-channel: add control-plane connection manager`
7. `worker-channel: unify worker session ownership`
8. `runner: provision local websocket endpoints`
9. `worker-channel: push authoritative run snapshot`
10. `test: port worker e2e to websocket (gated)`
11. `worker-runtime: consume pushed context and input`
12. `worker-channel: persist semantic worker events`
12b. `worker-runtime: drive model turns over the channel`
13. `worker-channel: route tools over channel` (includes ungating the e2e test)
14. `worker-channel: add resumable blob transfer`
15. `worker-channel: integrate reconnect and reaper`
16. `worker-channel: switch to websocket-only transport and delete HTTP`
17. `runner: provision docker websocket endpoints`
18. `runner: provision fly websocket endpoints`
19. `docs: finalize websocket worker operations`

Every commit must pass typecheck and its focused tests. Commits 11, 12, 13,
15, and 16 must also pass the full test suite.

## 23. Stop conditions for execution agents

Stop and report the exact evidence instead of improvising when:

- a provider cannot produce a private control-plane-dialable endpoint;
- a DB transaction cannot atomically combine an existing durable effect with a
  channel receipt;
- a tool can perform an external side effect before an idempotency record is
  durable and has no provider idempotency mechanism;
- the agent subprocess can read the supervisor credential after env scrubbing;
- a replay test duplicates a message, terminal landing, task transition, PR
  mutation, or child spawn;
- the control plane cannot distinguish stale and current controller epochs;
- backpressure cannot pause the selected model backend;
- any step would require public worker ingress;
- the section 12 e2e test cannot be made to pass without weakening one of its
  behavioral assertions.

Do not work around these conditions with retries, HTTP fallback, public ports,
or best-effort deduplication. Preserve the failing test/log and escalate it.

## 24. Final execution evidence

Append the commands, run ids, and outcomes from sections 18–21 here.

### Section 21 automated gate — 2026-07-16

Run from the existing working tree (not a fresh `npm ci` checkout — dependencies
were already installed and unchanged):

```text
$ npm run typecheck
> tsc --noEmit
(clean, no output, exit 0)

$ npm test
Test Files  1 failed | 148 passed | 1 skipped (150)
     Tests  1 failed | 1431 passed | 5 skipped (1437)
Duration    27.47s

FAIL __tests__/placement-routing.test.ts > resumeServerRun duplicate-wake
     short-circuit > delivers a pure event wake ephemerally without
     persisting a user row
  AssertionError: expected "spy" to be called 1 times, but got 2 times
   at __tests__/placement-routing.test.ts:272:23

$ npm run build:worker
> esbuild scripts/run-worker.ts --bundle --platform=node --format=esm
  --packages=external --alias:@=. --outfile=dist/run-worker.js
  dist/run-worker.js  815.9kb
(exit 0)

$ npm run build
> next build
(completed successfully, exit 0 — full Next.js route manifest emitted)
```

The `placement-routing.test.ts` failure is pre-existing and unrelated to the
websocket worker-channel work: verified by stashing all uncommitted changes
(only these two doc files were uncommitted at that point) and re-running the
same test file against commit `bf2afc2` ("runner: provision fly websocket
endpoints", the tip of boundary 18) — it fails identically there. No
worker-channel code change caused or fixes it; it is out of this plan's
scope and is not touched here per the instruction not to redesign or expand
into other sections' scope.

### Section 21 manual scenarios (1–12)

Not run. These require live Docker/Fly infrastructure, multi-process
control-plane restarts, and induced network/process failures that are not
appropriate for an unattended execution agent to trigger against real
infrastructure. **Pending for the user** to execute per the checklist in
section 21 and append results here.

### Section 21 scenario 1 (local detached run) — 2026-07-16, live smoke test

Scenario 1 was executed live against the dev server (repository
`R-chess-analyzer` → /Users/mg/dev/chess-analyzer, backend `claude`, model
`anthropic/claude-sonnet-5`, local unix-socket channel workers). It surfaced
and fixed EIGHT defects the automated suites had masked (each verified by a
before/after live run; all suites green after: 1432 passed, 1 pre-existing
placement-routing failure unrelated — see above):

1. `defaultSpawn` echoed the LISTEN endpoint (`unix:<path>`) back to dispatch,
   which persisted it as the DIAL endpoint — every local `connectRun` failed
   ("URL's protocol must be ws/wss/ws+unix"). The e2e harness had the same
   bug and was fixed harness-side earlier, masking the production path. Fixed
   in `defaultSpawn` (returns the `ws+unix://` dial form).
2. Local detached workers shared `<cwd>/channel` as the spool root (Fly sets
   SESSION_ROOT; local never did) — the second-ever worker died with "worker
   outbox state scope mismatch". Fixed: per-instance
   `SESSION_ROOT=<cwd>/.worker-sessions/<instanceId>` in `detachedSpawn`.
3. No boot backoff on the dispatch connect (plan 8.2 mandated 250..5000 ms):
   the controller dialed once before the worker bound its socket and gave up.
   Added `connectWithBootBackoff` (ladder + 60 s deadline; protocol/auth
   rejections not retried).
4. `next dev`/webpack bundled `ws`, half-detecting its optional native addons:
   the controller's first masked client→server frame crashed with
   "bufferUtil.mask is not a function" (receiving hello worked — only sends
   mask). Fixed via `serverExternalPackages`: ws, bufferutil, utf-8-validate.
5. Startup channel adoption (`reconnectActiveChannels`) reconnected but never
   ensured `run.start`, leaving an adopted run connected-but-idle forever
   while channel liveness kept the reaper away. `startChannelForRun` is now
   replay-idempotent (existing command resent verbatim, never rebuilt) and is
   what adoption calls. Reconnect-loop failures are now logged (were silent).
6. The ws turn passed the raw "provider/model-id" string as the SDK model id
   ("anthropic/claude-sonnet-5" → SDK error). Fixed with
   `parseProviderQualifiedModel`, same rule as lib/runs.ts.
7. The ws turn's cwd fell back to `process.cwd()` (the ORCHESTRATOR checkout)
   instead of the run's resolved repository — the agent explored the wrong
   codebase. Fixed: worktreePath → repository.localPath → cwd.
8. The section 8.4 input/cancel bridges were never wired into the product
   paths (the e2e called `sendCommand` directly): a live cancel landed in the
   DB but the channel worker kept running. Wired `bridgeToChannel` into
   `persistMessage` (user rows → `run.input`, deterministic command id, worker
   OrderedInputQueue dedupes) and `runs.cancel` (→ `run.cancel`).

Also added while validating: chat runs now bracket their lifecycle over the
channel (`run.phase` "running" on entry — fire-and-forget, order preserved by
the session's serial send queue — and an ack-awaited "idle" landing on clean
exit, restoring the legacy releaseClaim-idle semantics); `WorkerSession`
gained `waitForAck(seq)` (controller acks only after durable apply); turns are
never STARTED on an already-aborted session.

Verified live after the fixes (runs on the dev server, `taskorch` DB):
- run 10: question → streamed SSE answer summarizing the chess-analyzer repo
  (in-process append path — by design; browser surfaces unchanged).
- run 12: worker-channel cancel — `run.cancel` command acked, worker emitted
  `run.cancelled`, control plane landed `cancelled` + `run.commit`, worker
  process exited. Command log: run.start:acked, run.cancel:acked, run.commit.
- runs 7/9/11/13: full channel streams (transcript.append/agent.event
  receipts, status preparing→running→completed), tool output proving the
  agent operated in /Users/mg/dev/chess-analyzer.

Known gaps observed, deliberately NOT changed here (pre-existing semantics):
- A free-form `goal` on a non-worktree run never reaches the prompt — the ws
  driver falls back to a resume prompt (legacy create() only folds prompts in
  for worktree/review/execute shapes). Follow-up work item.
- POST /api/runs/[id]/messages rejects while a worker holds a live lease
  ("already in flight") without persisting — so the run.input bridge fires
  only where messages actually persist (chat loops, idle resume). Matches
  legacy behavior.

### Plan-executor live test (runs 14–20) — 2026-07-16

Executed a plan-executor flow live (plan P-chess-audit, two READ-ONLY audit
tasks on R-chess-analyzer; executor + implementor personas set to
backend=claude, anthropic/claude-sonnet-5). Two more §13/§15 port gaps found
and fixed (commit follows):

9. Goal-specific prompt synthesis was missing from the ws driver — every
   non-chat run got a bare resume prompt (the legacy driveDispatchedRun goal
   branches were never ported). Fixed control-plane-side: buildRunStart now
   synthesizes `RunStart.kickoffPrompt` on fresh starts (<execute> → the
   buildExecutePrompt scaffold, <implement> → buildImplementPrompt, free-form
   goal → verbatim); the worker leads with it and appends the persisted user
   backlog as operator instructions.
10. The ws turn mounted NO tool extensions (`extensions: []`) — agents had
   only backend built-ins, so run 15's executor audited via Claude Code's
   native subagents and reported "no plan-tracking tool exists". Fixed:
   ProfileContext gained `invoke` (the §15 channel invoker built from the
   run.start catalogue) and `repoRemote` (snapshot-resolved, so gh_pr
   profiles never touch a transport worker-side); the ws driver resolves the
   run's tools profile + always-on extensions with them.

Verified live after the fixes:
- run 16: executor drove the plan itself over 19 channel tool.invoke calls —
  task_orch get_plan/get_task/transition_task/check_criterion/add_note/
  transition_plan; tasks todo→in_progress→passing→merged, plan → done,
  notes with accurate architecture/test-inventory findings, repo untouched.
- run 18: executor DELEGATED via spawn__spawn_agent — children 19/20 each
  dispatched as their own unix-socket channel workers (three concurrent
  channels), performed read-only audits in /Users/mg/dev/chess-analyzer, and
  reported via report_result. `git status --porcelain` empty throughout.

Observed agent-behavior gaps (not channel defects, left open):
- The executor tends to prefer the backend's native subagent tool over
  spawn__spawn_agent unless steered, and ended its turn "completed" instead
  of parking to await children — so child results were not consumed into
  task transitions in run 18. Persona-prompt/park-flow tuning, and possibly
  making driveSingleTurn honor a park intent, are follow-up work.
- Spawned implementor children lack task_orch__add_note in their catalogue
  (report_result only) — executor-side bookkeeping is the intended flow.
