# Control plane → worker WebSocket protocol

Status: proposed design. This document describes the replacement for
`docs/worker-http-api.md`; it is not the currently deployed protocol.

## Decision

Each worker is a small WebSocket server. The control plane is the WebSocket
client and opens one connection to the worker assigned to a run.

The connection is an actor channel, not the existing `RunTransport` HTTP API
translated endpoint-for-message. The control plane owns all durable state and
sends commands. The worker owns the model process and checkout and emits facts
about what happened. A worker never opens a connection to the control plane,
calls an orchestrator API, accesses Postgres, or polls for work or cancellation.

```
 user / scheduler
        │
        ▼
 ┌──────────────────── control plane ────────────────────┐
 │ authoritative run state, DB, tool registry, leases    │
 │                                                       │
 │ WebSocket client                                      │
 └──────────────┬────────────────────────────────────────┘
                │ commands ↓       ↑ events / invocations
                │ one ordered, authenticated channel
 ┌──────────────▼────────────────────────────────────────┐
 │ worker supervisor (WebSocket server)                  │
 │ checkout, agent backend, outbound replay spool        │
 └───────────────────────────────────────────────────────┘
```

This direction matters operationally:

- cancellation and user input are pushed by the control plane;
- liveness is measured by the control plane with WebSocket ping/pong;
- workers do not need control-plane URLs, database credentials, or permission
  to reach the control plane network;
- the control plane decides when a run is complete and applies every state
  transition;
- a worker is inert until its authenticated controller sends `run.start`.

## Non-goals

- Exposing a general RPC or CRUD API to workers.
- Letting workers choose or claim runs.
- Making WebSocket delivery exactly-once. Delivery is at-least-once and effects
  are idempotent.
- Sending provider lifecycle operations over this protocol. Creating, starting,
  suspending, and destroying a Docker/Fly/Box instance remain provider concerns.
- Replacing browser-facing SSE or HTTP APIs.

## Roles and state ownership

| Concern | Owner |
| --- | --- |
| Run/task/plan state, messages, events, inbox, memories | Control plane |
| Worker claim and controller lease | Control plane |
| Tool authorization and execution | Control plane |
| User input and cancellation ordering | Control plane |
| Checkout, model process, SDK resume files | Worker |
| Unacknowledged worker frames during a disconnect | Worker supervisor |
| Reconnect and worker replacement | Control plane |

The worker may report a desired lifecycle outcome, but it cannot transition a
run directly. For example, `run.finished` is an observation. The control plane
validates it, persists the terminal state and responds with `run.commit` before
the worker tears down.

## Endpoint discovery

The worker listens on a provider-private endpoint supplied at provisioning:

| Provider | Endpoint |
| --- | --- |
| Local child | Unix socket at a control-plane-created path. TCP loopback is a fallback. |
| Docker | Fixed container port on the private Docker/Compose network; dial by container name. Do not publish it on the host. |
| Fly | Fixed port on the Machine's private 6PN address, obtained from the Machines API. |
| Box | Requires a provider-supported private ingress/tunnel and endpoint discovery. Box must not silently fall back to worker-initiated HTTP or WebSocket. |

`RunnerRef` therefore grows a `channelEndpoint` field. The resolved endpoint is
stored on `runner_instances` so a new control-plane process can reconnect after
a deploy. It must never be a public unauthenticated URL.

The control plane retries the WebSocket upgrade while the newly created worker
boots. Opening the authenticated channel is the readiness check; there is no
worker health HTTP endpoint.

## Upgrade and authentication

The control plane connects to:

```
GET /worker/channel
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: task-orchestrator.worker.v1
Authorization: Bearer <instance credential>
```

The instance credential is unguessable, single-instance, and scoped to
`{runId, instanceId}`. The implementation derives it with HMAC-SHA256 from a
control-plane secret plus the random instance id, allowing a restarted control
plane to reproduce it without storing plaintext. It is injected into the worker
supervisor when the instance is created and is replaced whenever the instance
is replaced. It is not a user/session JWT and conveys no control-plane API
authority.

For private local and Docker networks, `ws` is permitted. Across hosts or any
network not controlled as one trust domain, use `wss` with server certificate
validation; mTLS is preferred. Application authentication is still required
when TLS is present.

The supervisor must remove the instance credential and listener configuration
from the environment passed to the agent/model subprocess. Since agent shell
tools are intentionally powerful, a stronger security boundary additionally
requires a separate OS user or container for the supervisor.

## Envelope

All post-handshake, non-blob application messages are UTF-8 JSON text frames
with this envelope:

```ts
type Envelope<T = unknown> = {
  v: 1;                         // selected protocol major
  type: string;                 // namespaced message type
  id: string;                   // UUID; stable across replay
  runId: number;
  instanceId: string;
  controllerEpoch: number;
  seq: number;                  // worker-lifetime or controller-epoch sequence
  sentAt: string;               // ISO-8601, diagnostic only
  replyTo?: string;             // request id for a result/rejection
  payload: T;
};
```

Rules:

1. `id`, not `seq`, is the idempotency key for a durable effect.
2. `seq` detects gaps and supports cumulative acknowledgement. Worker event
   sequence numbers are monotonic for the lifetime of an instance, including
   across controller reconnects. Control-plane command sequence numbers are
   monotonic within a `controllerEpoch`.
3. Unknown message types or unknown required fields are protocol errors.
   Unknown optional payload fields are ignored.
4. A JSON frame is limited to 1 MiB. Larger content uses the blob transfer
   described below.
5. There is at most one active run per worker channel in v1. Every frame still
   carries `runId` and `instanceId` to make cross-wiring fail closed.

## Handshake and fencing

Handshake frames use the same JSON field names but are not application
messages: they have `seq: 0`, are not spooled, and are never acknowledged. The
examples below show only the fields relevant to negotiation.

After the upgrade the worker speaks first:

```json
{
  "v": 1,
  "type": "channel.hello",
  "payload": {
    "protocol": { "min": 1, "max": 1 },
    "workerBuild": "git-sha-or-image-digest",
    "capabilities": ["binary-blobs", "durable-spool"],
    "lastControllerEpoch": 7,
    "lastAckedControlSeq": 41,
    "nextWorkerSeq": 93
  }
}
```

The control plane obtains a DB-backed controller lease, increments the run's
`controllerEpoch`, and replies:

```json
{
  "v": 1,
  "type": "channel.accept",
  "payload": {
    "protocol": 1,
    "controllerEpoch": 8,
    "leaseId": "...",
    "lastAcceptedWorkerSeq": 91,
    "heartbeatMs": 10000,
    "disconnectGraceMs": 60000,
    "maxInFlightBytes": 8388608
  }
}
```

`controllerEpoch` fences split brain. The worker accepts commands only from the
highest authenticated epoch it has seen, closes the older channel when a higher
epoch arrives, and persists that epoch in its session volume. The control plane
may manage a channel only while it owns the corresponding DB lease.

A replayed worker event retains the epoch under which it was first emitted. A
new controller may accept such an event when its instance id and worker-lifetime
sequence are valid. Fencing applies to commands sent *to* the worker; otherwise
an epoch change could make the worker's unacknowledged output impossible to
recover.

If protocol ranges do not overlap, the control plane sends
`channel.reject { reason: "protocol_mismatch" }`, closes with code `4406`, and
replaces the worker with a current image. Additive changes stay within a major;
breaking changes increment it.

## Starting or resuming a run

The first command for an unstarted worker instance is `run.start`. (A reconnect
first replays any unacknowledged commands and does not create a new start.) It
is a self-contained input bundle, not a set of reads the worker must perform:

```ts
type RunStart = {
  mode: "start" | "resume";
  run: RunSnapshot;
  task: TaskSnapshot | null;
  plan: PlanSnapshot | null;
  persona: PersonaSnapshot;
  repository: RepositorySnapshot;
  transcript: MessageSnapshot[];
  inboxDigest: string | null;
  memoryContext: string;
  pendingInput: MessageSnapshot[];
  policy: {
    allowedTools: string[];
    maxTurns: number | null;
    deadline: string | null;
  };
};
```

Attachments are referenced by blob id and transferred on the same channel
before the worker acknowledges the command. Secrets needed for Git or model
providers remain supervisor-managed injected credentials, not fields in the
snapshot and not durable protocol logs.

The worker durably records the command, prepares the checkout/model process,
then sends `run.ready { startId }`. A repeated `run.start` with the same `id`
must return the same `run.ready` and must not start a second model turn.

## Message catalogue

### Control plane → worker commands

| Type | Purpose |
| --- | --- |
| `run.start` | Start or resume from a complete authoritative snapshot. |
| `run.input` | Deliver one or more persisted user messages in message-id order. |
| `run.cancel` | Abort the active turn immediately; includes reason and request id. |
| `run.park` | Stop model work but retain resumable worker state. |
| `run.commit` | Confirms the control plane durably accepted a finish/failure/cancel outcome. |
| `tool.accepted` | Tool invocation was validated and is executing asynchronously. |
| `tool.progress` | Optional progress for a long-running tool. |
| `tool.result` | Final tool result, including structured error results. |
| `blob.open` | Announce an attachment blob about to be sent as binary frames. |
| `blob.accepted` | Accept/resume/complete a worker-sent blob (see Blob transfer). |
| `blob.rejected` | Refuse a worker-sent blob (size, digest, or policy violation). |
| `channel.ack` | Cumulative acknowledgement of worker sequence numbers. |
| `channel.drain` | Stop accepting new work, flush outstanding frames, then close. |

### Worker → control plane events

| Type | Purpose |
| --- | --- |
| `run.ready` | `run.start` has been applied and execution may begin. |
| `run.phase` | Preparing/running/pushing or other observable phase change. |
| `transcript.append` | Agent/tool/system content to persist and stream to the UI. |
| `agent.event` | Structured shell, warning, prompt, or diagnostic event. |
| `tool.invoke` | Ask the control plane's tool registry to execute an authorized tool. |
| `run.checkpoint` | SDK resume id and resumable local-state metadata. |
| `run.finished` | Proposed successful outcome, usage, result, and PR metadata. |
| `run.failed` | Proposed failed outcome with normalized error information. |
| `run.cancelled` | Confirms model abortion and local cleanup for `run.cancel`. |
| `worker.log` | Bounded diagnostic log batch. |
| `blob.open` | Announce an image/attachment blob about to be sent as binary frames. |
| `blob.accepted` | Accept/resume/complete a control-plane-sent blob (see Blob transfer). |
| `blob.rejected` | Refuse a control-plane-sent blob (size, digest, or policy violation). |
| `channel.ack` | Cumulative acknowledgement of control-plane commands. |

There are deliberately no `getTask`, `patchRun`, `heartbeat`, `releaseClaim`,
or arbitrary database operations. Context comes in `run.start`; subsequent
domain reads and writes happen through named tools; lifecycle facts use the
semantic messages above.

## Tool invocation

An agent tool call is an invocation event on the existing channel:

```json
{
  "type": "tool.invoke",
  "id": "5c6...",
  "payload": {
    "callId": "model-tool-call-id",
    "tool": "task_orch__transition_task",
    "arguments": { "taskId": "T-...", "state": "review" }
  }
}
```

The control plane derives the run, task, plan, author, and authorization scope
from the channel; the worker cannot override them in the payload. The control
plane deduplicates by envelope `id`, executes through the server tool registry,
persists any resulting events, and replies with `tool.result` using `replyTo`.

Long-running tools first receive `tool.accepted`. Their eventual result is
pushed later; no connection or request is held in a blocking RPC call. If the
worker disconnects, the result is replayed after reconnect. A cancelled run
does not imply that an already committed external side effect can be undone.

## Delivery, replay, and backpressure

WebSocket ordering alone is insufficient because a connection can disappear
after the receiver applies a frame but before the sender observes the ack.

- Both sides keep an ordered outbox until `channel.ack { throughSeq }`.
- The receiver stores accepted message ids with the effect they produced.
- On reconnect, handshake cursors select the replay range.
- Durable worker events are applied exactly once by idempotency key even though
  they may be delivered more than once.
- Control commands are idempotent. Repeating `run.cancel`, `run.commit`, or
  `run.start` returns/re-emits the prior acknowledgement.
- A sequence gap produces `channel.nack { expectedSeq }`; later frames are not
  applied until the gap is replayed.

`channel.ack` and `channel.nack` are unsequenced transport frames (`seq: 0`).
They are not put in an outbox and are not themselves acknowledged, avoiding an
acknowledgement loop. A lost ack merely causes safe replay and deduplication.

The control plane advertises `maxInFlightBytes`. The worker stops reading new
model output when its unacknowledged outbox reaches that window, allowing
backpressure to reach the producer. Diagnostic logs may be coalesced or dropped
with a reported count; transcript, tool, checkpoint, and terminal frames may
not be dropped.

The worker's replay spool is stored on its session volume using append + fsync
before a durable event is sent. A memory-only spool is acceptable only for
non-resumable local development.

## Blob transfer

Attachments and image tool results can exceed the JSON limit. The sender first
sends `blob.open` with `{blobId, size, sha256, mimeType, purpose}`, then binary
frames. A binary frame is:

```
byte 0       protocol major
byte 1       flags (bit 0 = final chunk)
bytes 2..17  raw 128-bit blob id
bytes 18..21 chunk number, unsigned big-endian
bytes 22..   data
```

`blob.open` and the acceptance replies are ordinary sequenced JSON messages in
each direction's catalogue; only the chunk frames are binary and unsequenced
(they are correlated by blob id + chunk number, not envelope seq).

`blob.accepted { blobId, nextChunk, complete }` serves three moments:

1. reply to `blob.open` — `nextChunk` is `0` for a fresh blob, or the persisted
   resume cursor for a partial blob re-opened after reconnect;
2. periodic window ack — after durably persisting roughly half of
   `maxInFlightBytes` of new chunk bytes, the receiver echoes `blob.accepted`
   with `complete: false` and its current `nextChunk`. This releases the
   sender's in-flight budget so its pump can advance. It is a coarse window ack,
   not a per-chunk echo, and it is what makes chunk bytes count toward the ack
   window (see Blob transfer below);
3. after the final chunk, the receiver verifies declared size and SHA-256 and
   sends `blob.accepted` with `complete: true` (or `blob.rejected` with a
   reason; a digest mismatch is a protocol violation and also closes with
   `4403`).

Ordering rule, made precise: a SENDER must not send a message that references a
blob until it has seen `blob.accepted { complete: true }` for that blob. A
receiver treats a reference to an unknown or incomplete blob as a protocol
violation. The one exception is `run.start`: its attachment blobs are sent
immediately after the command, and the worker defers applying the command
(and its `run.ready`) until all referenced blobs are complete.

Blob references inside `run.start` attachments, `transcript.append` image
content blocks, and image `tool.result`/`tool.invoke` payloads use one block
shape:

```json
{ "type": "blob", "blobId": "…", "mimeType": "image/png", "size": 12345,
  "sha256": "…", "purpose": "attachment" }
```

The same ack window governs blob bytes (chunk bytes count toward
`maxInFlightBytes`). Partial blobs resume at the receiver's persisted chunk
cursor after a reconnect via re-`blob.open`. Deployment limits still cap an
attachment at 25 MiB.

## Liveness, cancellation, and disconnects

The control plane sends WebSocket ping frames every `heartbeatMs`; any valid
worker frame or pong renews the control-plane-owned run lease. The worker does
not send heartbeat requests. Two missed intervals mark the channel unhealthy.

Cancellation is one pushed `run.cancel` command. The worker aborts the model,
kills owned subprocesses, flushes prior durable output, and emits
`run.cancelled`. The control plane then persists the terminal state and sends
`run.commit`. Provider `stop()` remains a hard-stop fallback after the cancel
deadline.

On an unexpected disconnect:

1. The worker pauses new model/tool work and spools output already in flight.
2. The control plane reconnects to the same instance during
   `disconnectGraceMs` and replays from the negotiated cursors.
3. A worker with no authenticated controller after the grace period aborts its
   model subprocess and exits or parks according to run mode. It never seeks a
   control plane itself.
4. If the instance is gone or the grace expires, the control plane's existing
   reaper replaces/re-dispatches it from the last durable checkpoint.

During a control-plane restart, the new process reads active
`runner_instances.channel_endpoint` rows, acquires controller leases, and dials
workers. This replaces today's assumption that workers will reconnect to a
newly deployed API server.

## Close codes

| Code | Meaning | Retry |
| --- | --- | --- |
| `1000` | Clean drain after `run.commit` | No |
| `1011` | Transient internal worker error | Yes, then replace if repeated |
| `4401` | Invalid instance credential | No; replace credential/worker |
| `4403` | Run or instance scope mismatch | No |
| `4406` | No compatible protocol major | Replace worker image |
| `4408` | Handshake or acknowledgement timeout | Yes |
| `4409` | Stale controller epoch | Current controller should not retry |
| `4413` | Frame or blob exceeds negotiated limit | No for that frame |

## Observability

Every frame is logged as metadata only: direction, type, id, run id, instance
id, epoch, sequence, bytes, replay flag, latency, and outcome. Message bodies,
tool arguments/results, credentials, and blob bytes are not placed in transport
logs. Useful metrics include:

- channel connect and handshake latency;
- active channels by provider;
- reconnects and fenced controllers;
- unacknowledged frames/bytes and oldest-frame age;
- ping/pong RTT;
- command-to-event latency for cancel and input;
- tool invocation duration;
- replay and deduplication counts.

The existing `agent_messages` and `agent_events` tables remain the UI replay
source. WebSocket transport logs are diagnostics, not a second run history.

## Migration

1. **Introduce the supervisor and connection manager.** Add worker listener
   endpoint discovery, instance credentials, controller leases/epochs, and a
   channel manager without changing the model loop.
2. **Compatibility adapter.** Implement a temporary socket-backed
   `RunTransport` so the existing drive loop can run while HTTP/SSE is removed.
   This adapter is a migration tool, not the final wire contract.
3. **Move bootstrap reads to `run.start`.** Build the authoritative snapshot in
   the control plane and delete worker-side task/plan/persona/repository reads.
4. **Move writes to semantic events.** Replace run patches, status writes,
   heartbeat, claim release, and log APIs with the messages in this document.
   Route all domain mutations through `tool.invoke`.
5. **Remove HTTP worker ingress.** Delete `/api/worker/*`,
   `http-transport.ts`, worker API tokens/URLs, and the worker-side SSE control
   stream. Keep the DB transport only inside the control plane.
6. **Enable providers one at a time.** Local, Docker, Fly, then Box after Box has
   a supported control-plane-to-worker endpoint. Do not mix transport direction
   within one provider.

Migration is complete when a worker network policy can deny all worker egress
to the control plane and a full run—including input, cancellation, tool calls,
resume, and terminal persistence—still succeeds.

## Acceptance tests

- Worker egress to control-plane HTTP is denied; a full run completes.
- The control plane restarts mid-turn and reconnects without duplicate messages
  or tool effects.
- The socket drops after a tool effect commits but before its result is acked;
  replay returns the original result without executing twice.
- User input and cancellation are delivered without worker polling.
- A stale control-plane replica cannot command a worker after a higher epoch
  connects.
- Backpressure pauses model output rather than growing memory without bound.
- A 25 MiB attachment resumes after an interrupted blob transfer and verifies
  its digest.
- A worker that never receives an authenticated controller self-terminates or
  parks after the configured grace period.
- Protocol-major mismatch replaces the worker rather than retrying forever.
- The agent subprocess cannot read the instance credential from its environment.
