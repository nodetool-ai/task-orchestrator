# Run 248: retained Sprite worker lifecycle failure

Reviewed 2026-09-11 against repository HEAD `d3b320d`.

This is a proposed repair, not an applied runtime patch or a production intervention. Production timestamps and service observations below come from the supplied incident account; they have not been independently retrieved from production. Code references describe this checkout, which must be compared with the deployed revision before attributing every branch to the incident.

The idle-only trigger is the initiating defect. Accepting `failed` as successful teardown breaks the recovery fence. Remembering only one predecessor makes an older restartable service escape subsequent replacements. **Changing the trigger alone is insufficient.**

## Causal timeline

The incident account does not specify a date or time zone for these clock times. Do not silently interpret them as UTC or Amsterdam time.

| Incident clock | Observation | Causal significance |
| --- | --- | --- |
| Before 09:53:15.716 | Generation 44 acknowledged `run.start`. | It was an initialized worker, not merely an unsuccessful boot. |
| 09:53:15.716 | Generation 44 acknowledged `run.park`. | The worker accepted the controller's decision. This acknowledgement is not a provider stop. |
| 09:53:15.744 | Final `run.phase` receipt persisted. | Under the described parked path, the transaction lands `parked` and releases the v2 worker claim, but does not schedule Sprite cleanup. This is 28 ms after the command acknowledgement. |
| 09:53:15.789 | Worker logged `worker finished`. | The driver returned, 45 ms after the receipt. The script still flushes logs and closes its supervisor before `process.exit`; this line is not the exact OS exit time. |
| Approximately 09:53:48 | Generation 45 started. | Generation 44 was no longer preventing this bind at that instant. That does not establish that its service definition had been disabled. |
| Approximately 09:54:13 | Generation 45 completed/parked. | Its endpoint became available again at some subsequent point; the exact unbind time was not supplied. |
| Between worker completion and 09:54:28 | Generation 44's supervised service restarted. | A normal worker exit did not permanently disable the provider supervisor. Failed/restarting intervals can create a window in which a replacement appears to work. |
| 09:54:28 | Generation 44 bound port 8787 again. | This is 72.211 seconds after its `worker finished` log. It demonstrates that 44 remained restartable across generation 45. |
| Later; individual timestamps unavailable | Generations 46–50 failed with `EADDRINUSE :::8787`. | Their generation-specific identities do not isolate a shared TCP listener. The stale worker can occupy the endpoint before any authentication or generation check occurs. |
| Subsequent startup attempts | Controller exhausted its boot window, reporting a tunnel handshake timeout; run failed after three infrastructure-start attempts. | A transport symptom obscured the pre-handshake worker fatal. Generation count, infrastructure attempt count, and user run attempt are distinct counters. Do not equate five generations with five attempts in one retry budget. |
| Later user resume | Run became `preparing`, attempt increased, input remained `pending`; startup still failed. | Request persistence succeeded. The failure was in provider startup, before pending input could be consumed by a healthy replacement. |

The code supports the following race, but the supplied evidence does **not** establish the exact service-stop response received while starting generation 45:

1. The worker checkpoints, receives `run.park`, emits its final phase, and exits after the final phase acknowledgement.
2. The controller releases logical ownership without establishing physical quiescence. The service remains under Sprite supervision.
3. Replacement startup tries to stop only its captured predecessor. A stop error is swallowed; a subsequent `failed` observation is accepted even if a restart is scheduled. A stop/restart race can therefore falsely pass the teardown fence.
4. Generation 45 temporarily occupies the available port. Generation 44's restart/backoff remains unresolved.
5. The runner row advances. Future replacements target 45, then subsequent generations, rather than discovering 44 from the provider's service inventory.
6. Generation 44 later wins the bind, and the replacement sequence becomes a port-contention loop.

To prove step 3 happened in precisely that form in production, retrieve generation 45's stop requests, stream events, subsequent GET responses, and deployed source revision. Alternative explanations for that step include a missing/wrong predecessor name, or provider stop semantics differing from the documented sticky behavior. None changes the demonstrated need for an all-older-service startup fence.

## Ranked causes and supporting code

1. **Initiating defect: parked completion omits physical retirement.** [handleRunPhase](../lib/worker-channel/event-handler.ts#L196) releases the v2 claim for idle and parked, but schedules cleanup only for idle at line 231. [landBoundary](../lib/worker-runtime/context.ts#L911) waits for the phase acknowledgement; the durable task loop then returns at lines 1038–1045. [run-worker](../scripts/run-worker.ts#L128) logs completion, flushes, closes, and exits. None of those actions stops Sprite supervision.
2. **Recovery defect: teardown confirmation confuses process failure with a sticky stop.** [stopServiceAndConfirm](../lib/runner/sprites.ts#L861) ignores stop errors and returns on `failed`. It never checks `nextRestartAt`. Its 30-second confirmation clock starts after the initial stop request, so it is not a 30-second total operation deadline. Resume also bypasses confirmation for the literal legacy `worker` service at lines 809 and 824.
3. **Discovery defect: the durable row is the current owner, not a service inventory.** [resumeUnserialized](../lib/runner/sprites.ts#L705) derives one predecessor and stops only it at line 792. [dispatch allocation](../lib/run-dispatch.ts#L638) advances the row; its return value carries only the immediately previous name. Generation-specific service definitions accumulate independently of that row. Old names are no longer found through normal predecessor tracking, although they remain discoverable by `listServices` and historical logs.
4. **Diagnostics defect: pre-handshake errors are discarded or inaccessible.** [Sprites client](../lib/runner/sprites-client.ts#L394) reads create/start/stop NDJSON but ignores its semantics. [resume startup](../lib/runner/sprites.ts#L838) logs a thrown start error and continues. [connectWithBootBackoff](../lib/run-dispatch.ts#L1061) retries transport errors without collecting service diagnostics. The worker's channel log flusher starts only after the supervisor exists; a bind failure can precede that.
5. **Persistence gap: best-effort channel cleanup is not durable reconciliation.** [maybeCloseSpritesChannel](../lib/worker-channel/registry.ts#L491) requires a local supervisor and uses a timer. [boot adoption](../lib/worker-channel/registry.ts#L423) special-cases idle but not parked. [provider sweep](../lib/runner/sprites.ts#L985) and [applyLifecycle](../lib/runner/sprites.ts#L1154) govern observation/retention/destruction; they are not an all-worker-service retirement reconciler. A callback lost to a crash cannot be the sole repair mechanism.

## API semantics verified, and limits

Verified from official documentation on 2026-09-11:

| API fact | Consequence |
| --- | --- |
| A service that exits on its own is restarted; an explicitly stopped service stays stopped until explicitly started. | Process completion and PID termination cannot substitute for a service stop. See [service lifecycle and sticky stops](https://docs.sprites.dev/concepts/services/). |
| Service states include `starting`, `running`, `stopping`, `stopped`, and `failed`. | `failed` describes failure, not a documented durable disablement. See [service API](https://sprites.dev/api/sprites/services). |
| API examples include `next_restart_at`, with Go zero time when no restart is shown. The local parser already normalizes that sentinel. | Any nonzero restart value must prevent quiescence confirmation. A past timestamp is also unsafe: its timer may be due, delayed, or racing. Do not check only `Date.parse(value) > now`. See [GET examples](https://sprites.dev/api/sprites/services#get-service). |
| Stop returns NDJSON, with `stopping`, `stopped`, `error`, and `complete` events; its `timeout` defaults to 10 seconds. | HTTP 200 or EOF alone is insufficient. Inspect stream errors and verify sticky state with a follow-up GET. See [stop endpoint](https://sprites.dev/api/sprites/services#stop-service). |
| Service creation starts the process and streams early output. | Quiesce predecessors **before PUT**, not merely before the subsequent POST start. See [service creation](https://docs.sprites.dev/concepts/services/#create-a-service). |

The public reference does not fully specify restart timer cancellation internals, backoff intervals, or linearizability of stop versus a timer already firing. The newer dev-latest reference does not document `next_restart_at` in its schema. Production observations and the existing parser establish its relevance, but do not prove a numerical retry schedule. Validate sticky stop against a deliberately crash-looping service on an isolated test Sprite before rollout; do not use run 248 as that experiment.

The client currently consumes the entire stream via `response.text()`. It is inaccurate to describe it as merely fire-and-forget. Its defect is discarding error/completion information, and its buffering also delays fatal reporting until the stream ends.

## Lifecycle invariants

1. **One potential port owner:** before any PUT/start of generation G, every older owned worker service is confirmed sticky-stopped or absent. A failed service with a timer is a potential owner even when it has no process.
2. **Exact ownership:** cleanup carries `(runId, spriteName, generation, instanceId, serviceName)`. Logical row updates additionally obey the current operation fence. Late cleanup never resolves its target from a newer runner row.
3. **Durable retirement:** committing a v2 final idle/parked boundary records retirement intent. Callback delivery is only an optimization. Boot and periodic reconciliation retry outstanding retirement; replacement startup inherits cleanup of older services.
4. **Fail closed:** provider errors, malformed service lists, missing state, incomplete stop streams without authoritative stopped-state evidence, and scheduled restarts do not authorize a replacement.
5. **Input ownership survives:** cleanup neither consumes nor deletes inputs, turns, messages, or SDK session data. A committed park decision retires that generation; pending work must cause a replacement, not delivery into an exiting worker.
6. **Retain the environment:** generation retirement does not delete the Sprite, restore a checkpoint, clear `sdkSessionId`, change `SESSION_ROOT`, or remove checkouts/dependencies. New generations receive fresh channel spool identities while retaining SDK state.
7. **Honest distributed guarantee:** `parked` is a logical status, not an instantaneous assertion about a remote process. During an outage a service can remain physically live. The enforceable guarantee is durable retirement plus no replacement start until quiescence is established; eventual retirement assumes the provider and reconciler recover.

## Ordering and race review

**Acknowledgements.** `WorkerSession` delivers a command and then sends its command acknowledgement ([worker-session.ts](../lib/worker-channel/worker-session.ts#L660)). `landBoundary` separately emits and awaits the final phase acknowledgement. [applyWorkerEvent](../lib/worker-channel/repository.ts#L1277) flushes post-commit callbacks before returning; [ControllerConnection](../lib/worker-channel/connection.ts#L705) sends `channel.ack` afterward. The timer usually defers cleanup long enough for the send call, but neither `setTimeout(0)` nor the current void `send()` is an acknowledgement-flush guarantee.

Persist retirement intent in the event transaction. Trigger the fast physical cleanup path from the connection after the final ACK's socket-send callback, with a bounded grace for worker closure/log flushing. A socket send callback proves local flushing, not peer receipt; correctness rests on the committed boundary and replay-safe receipts. If the socket is already lost, durable reconciliation must still retire the worker. Do not wait for worker/channel acknowledgements while holding locks those acknowledgements need.

**Supervisor state.** Setting `supervisor.stopped = true` before provider stop correctly suppresses automatic reconnect. It does not exclude a direct `connectRun`: that function currently resets the flag and can return the cached connection. Add an explicit `quiescing` promise/state. Direct connection requests await cleanup and reload durable identity; they never revive that supervisor in place. On refusal/error, restore reconnect scheduling only if it is still the same owner and not durably retiring. On success, disconnect the captured connection and delete the registry entry only on object identity equality.

**Locks.** Keep the existing `sprites:<runId>` advisory lock, held for the complete provider mutation, plus the in-process queue. Quiescence takes lifecycle → channel → runner row → run row. Event application takes channel → runner and its semantic run updates; it must not acquire the outer lifecycle lock from inside that transaction. Allocation takes generation authority → Sprite lifecycle → source locks → run row. The shared lifecycle lock excludes allocation during quiescence. Do not call a serialized provider method recursively from a sweep already holding that lock; factor an unserialized helper.

The current implementation holds an outer transaction's advisory lock and an inner transaction's row locks using separate pool connections. Preserve that mutual exclusion or pass one transaction through a careful refactor; do not shorten lock lifetime accidentally. Bound provider calls so blocked user appends and database connections cannot wait indefinitely. Remote graceful stop must not depend on a channel write completing while those row locks are held.

**Follow-ups.** `dbTransport.appendMessage` locks the run before appending a user message and its v2 input ([db-transport.ts](../lib/worker/db-transport.ts#L114)). If cleanup gets the lock first, append waits and then persists input after retirement. If append wins, `hasReconnectableWork` detects it. However, merely returning `false` from quiescence is not a complete wake policy: the v2 worker already accepted park and is exiting. Return a distinct `wake-required` outcome and dispatch a replacement after releasing locks; the durable pending-input pump is the retry path. Preserve the veto for an actual active turn or unacknowledged work command. Legacy idle workers that truly remain available between turns need their existing behavior, not an unconditional v2 retirement rule.

**Late cleanup.** If N+1 allocates first, quiescence for N fails the exact generation/instance check and must not update N+1. If N cleanup gets the lifecycle lock first, N+1 cannot allocate until retirement completes. A late timer must carry N's identity, rather than calling a run-ID-only helper that might capture the new supervisor.

## Proposed patch

These are implementation specifications and pseudocode, not a claim that the runtime has been changed.

### A. Land and reconcile retirement

In `handleRunPhase`, handle both idle and parked. For v2 final boundaries, mark the exact runner `generationState = "stopping"` in the same transaction as the phase receipt. The existing column can represent durable retirement intent without a new table. Keep final receipt/log acknowledgement traffic possible; reject new turn delivery or channel promotion for a retiring generation.

Capture the event identity for cleanup. Move physical cleanup initiation to the post-ACK connection path described above. Teach boot adoption to handle parked, and add periodic service-only reconciliation over retained idle/parked/failed runner mappings, including mappings already marked stopped. That last inclusion discovers historical orphan definitions and prevents a falsely stopped row from hiding them.

```ts
// Event transaction: no provider I/O, no lifecycle-lock acquisition here.
if (durableV2 && (target === "idle" || target === "parked")) {
  await markExactGenerationRetiring(tx, frame.runId,
    frame.workerGeneration, frame.instanceId);
  set.workerScope = null;
}

// After commit and final ACK send completion, best-effort prompt reconciliation.
// Boot/periodic reconciliation also discovers retirement from durable state.
scheduleRetirement(capturedGenerationRef);
```

If new allocation overwrites the runner's retirement state, the new generation's compulsory provider inventory fence inherits responsibility for old services. No old cleanup job may change the new row. Reconciliation must distinguish unassigned pending work (`wake-required`, schedule replacement) from active work (defer and alert/reconcile the inconsistency), rather than treating every reconnectable state as an indefinitely reusable parked worker.

### B. Confirm sticky stops, with bounded retries

Remove the `confirm=false` escape hatch, including legacy service refresh. Require only absence or explicit stopped state with no nonzero restart marker; do not accept even unscheduled `failed` as proof of a sticky stop.

```ts
function quiescent(service: SpriteService | null): boolean {
  return service === null ||
    (service.state.status === "stopped" &&
     service.state.nextRestartAt === undefined);
}

async function stopAndConfirm(sprite, serviceName, deadline) {
  let lastStopError, lastState;
  while (timeRemaining(deadline) > 0) {
    try {
      // Common total deadline covers request, stream body, reads and backoff.
      // Validate NDJSON errors/completion; keep a bounded diagnostic tail.
      await client.stopService(sprite, serviceName, { deadline });
      lastStopError = undefined;
    } catch (error) {
      lastStopError = error; // unknown outcome: resolve it by authoritative GET
    }
    const service = await observeWithBoundedRetry(sprite, serviceName, deadline);
    lastState = service?.state;
    if (quiescent(service)) {
      // Re-observe to catch an in-flight stop/restart transition. This is not
      // a substitute for the provider's documented sticky-stop contract.
      await boundedDelay(deadline);
      if (quiescent(await observeWithBoundedRetry(sprite, serviceName, deadline))) return;
    }
    // Reissue stop after bounded backoff if failed/starting/running or a timer
    // remains, instead of only watching a still-enabled restart loop.
    await boundedBackoff(deadline);
  }
  throw teardownError({ sprite, serviceName, lastState, lastStopError });
}
```

Retain the Go-zero normalization. Preserve malformed/nonzero restart values as unsafe rather than converting them to absence. HTTP/stream errors must remain visible even when authoritative subsequent state resolves an ambiguous successful stop. A nonzero exit code on a stop event can result from termination; do not classify it like a startup crash. A `complete` start event only closes log monitoring; it does not establish worker readiness.

### C. Enumerate before any replacement starts

**Yes: enumerate and quiesce all older owned `worker` / `worker-g<N>` services under the existing per-run Sprite lock.** Make `listServices` required for this path and reject unavailable/malformed inventory. Do not silently fall back to the one predecessor.

```ts
await serializeSpriteOperation(runId, async () => {
  await assertCurrentGenerationOperation(input); // before ANY service mutation
  const services = await client.listServices(spriteName);
  const owned = services.filter(s => s.name === "worker" || /^worker-g[1-9]\d*$/.test(s.name));
  // Parse positive safe integers, compare numerically, never lexicographically.
  if (owned.some(s => generation(s) > input.workerGeneration)) {
    throw new Error("Provider has a newer worker generation; refusing stale startup");
  }
  const older = owned.filter(s => s.name === "worker" || generation(s) < input.workerGeneration);
  for (const service of older) await stopAndConfirm(spriteName, service.name, deadline);
  await assertOlderInventoryQuiescent(await client.listServices(spriteName), input);
  await assertCurrentGenerationOperation(input);
  // A same-generation process whose environment/code is replaced must also stop.
  await stopTargetIfRefreshRequired(input);
  await refreshWorkerBundleIfRequired(); // retains session/checkout/dependencies
  await client.putService(spriteName, input.providerServiceName, definition);
  await client.startService(spriteName, input.providerServiceName); // if needed
});
```

The final inventory check must inspect the complete older set, including any new entries, and fail closed if it differs unsafely. Never stop a greater generation to make a stale caller succeed. Preserve unrelated services. Validate legacy custom predecessor names explicitly if compatibility requires them; do not broaden matching to arbitrary service names. All app-controlled start/restart/PUT paths must share the lock; provider-internal timers are handled by sticky stops, not by the PostgreSQL lock.

Use this fence for resume and for create/adoption after a create-409 or retained mapping recovery. On a shared bundle refresh, older services must be stopped before replacing their common worker files. Once a retained Sprite is identified, failure cleanup must stop only the attempted generation and preserve the Sprite; do not let a create-409 mark a pre-existing Sprite as newly owned/destructible.

### D. Report the worker fatal

Validate PUT/start NDJSON and surface `error` and premature `exit`, including a bounded stderr tail. Stop swallowing thrown start errors in `resumeUnserialized`. Since a worker can die after the monitoring stream closes, collect exact-generation service state and bounded logs during boot failures and at final timeout. A provider-failed observation plus an explicit fatal can fail startup early; a cold VM or unknown inspection alone cannot.

Persist diagnostics before generation allocation clears `workerLog`. Include run attempt, infrastructure attempt, Sprite, service, generation, instance, PID/start time, next restart marker, original transport error and bounded worker fatal. Redact known credentials and do not dump service environments. Never fetch logs through the current runner name after a newer generation replaces the captured one.

Expected user-visible result:

```text
Worker generation 46 (worker-g46) failed before handshake:
listen EADDRINUSE :::8787.
Sprite inventory shows older worker-g44 running (restart state attached).
Replacement was blocked until older services could be quiesced.
```

A missing or failed log fetch supplements the timeout with “provider diagnostics unavailable”; it must not hide the original error or extend the boot deadline without bound.

## Regression-test matrix

Tests below specify actual entry points and assertions. They should be added alongside the existing suites; helper-only and static-source checks do not establish these contracts. Run lock tests against real Postgres using independently gated promises/connections, not mocked transactions or arbitrary long sleeps.

| Case / target suite | Controlled interleaving and assertions |
| --- | --- |
| Final parked event / `worker-channel-sprites-close` | Create a v2 `<execute>` run with G44 identity and acknowledged `run.park`; pass `run.phase: parked` through `applyWorkerEvent(frame, handleWorkerEvent)`. Verify committed phase receipt and retirement state, then exact G44 provider stop and captured connection disconnect. Do not call `maybeCloseSpritesChannel` as the trigger. |
| Real ACK ordering / controller integration | Gate the ACK send callback. Retirement intent must already be durable, but fast cleanup must not run until ACK send completes or the explicitly tested disconnect/fallback path takes over. Roll back the event transaction: neither receipt nor retirement may commit. |
| Restart timestamp parsing / `sprites-client` | Preserve future, past and malformed nonzero `next_restart_at`; normalize only documented empty/zero absence. Cover failed and stopped with nonzero timers. |
| Failed with future restart / `sprites-provider` | First stop leaves `{status: failed, nextRestartAt: future}`. Assert no replacement PUT/start and no success. A later stop clears the timer and returns stopped; only then may startup continue. Repeat for failed without a timer, which still requires a sticky stop. |
| Stop/restart race / `sprites-provider` | Observations progress failed-with-timer → starting → running → stopped-without-timer. Force timer firing between stop and GET. Require repeated stop, no early return, and no bind attempt while any predecessor is restartable. |
| Streaming stop / `sprites-client` | HTTP 200 with `error` then `complete` must expose an error; truncated stream must not be called successful. Already-stopped/idempotent and ambiguous-request outcomes are resolved by GET. A stop's nonzero exit code alone is not a startup-failure classification. |
| Multiple orphans / `sprites-provider` | Seed legacy worker, G44 running, G45 stopped, G46/G49 failed-with-timers, unrelated postgres service, target G50. Row remembers only G49. Assert all older owned services are stopped before PUT G50; postgres is untouched. Future G51 causes refusal, never stop G51. |
| Follow-up during parked cleanup / `sprites-provider` | Extend the existing idle append-lock test to v2 parked executor. Block provider stop, start real `dbTransport.appendMessage`, prove the run-row lock blocks it, release stop, assert original input identity is pending and replacement dispatch occurs after lock release. |
| Follow-up wins the lock | Persist pending user input before cleanup. Require `wake-required`/replacement routing; no `run.input` into the generation that has accepted park, no lost wake, no new input row invented by recovery. Also exercise pending inbox wake and active-turn veto separately. |
| Late cleanup N versus N+1 | Exercise both lock orders. N-first blocks allocation; N+1-first makes N row updates no-ops. A delayed registry callback and explicit stop of N must never stop N+1, delete its supervisor, or clear its claim. |
| Direct reconnect during cleanup / registry | Call `connectRun` while quiescing promise is unresolved. It must await/reload, never reset `stopped=false` and reuse a retiring connection. On cleanup refusal after a socket drop, verify the appropriate wake/reconnect is re-armed. |
| Controller crash / boot and periodic recovery | Commit parked boundary, omit callback, clear all local supervisors, run reconciliation. Service retirement must occur from durable state. Repeat when stored runner state is already stopped but older provider services remain restartable. |
| Recovery preservation / dispatch integration | Seed the SDK session identifier, pending input IDs/content/sequence, checkout and dependency sentinels. Inject the G44 port owner and failed starts. Recover through the same run's generation allocation/start snapshot. Assert same Sprite/SESSION_ROOT/SDK identity, fresh channel instance, original pending input included once, and no deleteSprite/restoreCheckpoint/clearSdkSession. Consume it only when the legitimate new turn protocol does so. |
| Diagnostic propagation / client + dispatch | Inject EADDRINUSE in create/start NDJSON and in a fatal occurring after the start stream closes. Persist/show the exact-generation fatal with the transport error, even after later allocation clears workerLog. Bound/redact output; test unavailable logs. |
| Provider outage / all startup routes | GET/list/stop timeouts or malformed inventory block PUT/start, preserve SDK/input state and leave retryable retirement. Cover legacy refresh, create-409, pooled resume, and two provider objects sharing the DB lock. |

Example test shape for the two principal missing regressions (fixture helpers represent the normal existing DB/provider harness, not mocks of the event handler):

```ts
it("retires a parked executor from its real phase event", async () => {
  const h = await executorFixture({ generation: 44, deliveryVersion: 2 });
  await h.persistAndAckParkCommand();
  await applyWorkerEvent(h.nextEvent("run.phase", { phase: "parked" }), handleWorkerEvent);
  await h.flushFinalAckAndWaitForCleanup();
  expect(await h.phaseReceiptCount()).toBe(1);
  expect(h.client.stopService).toHaveBeenCalledWith(h.spriteName, "worker-g44", expect.anything());
  expect(await h.sdkSessionId()).toBe(h.originalSdkSessionId);
});

it("does not start G50 while any older restart timer survives", async () => {
  const h = await replacementFixture({ current: 50, previous: 49, orphans: [44, 46, 49] });
  h.provider.keepRestartScheduledUntilReleased("worker-g44");
  const starting = h.resume();
  await h.provider.waitUntilStopObserved("worker-g44");
  expect(h.client.putService).not.toHaveBeenCalled();
  expect(h.client.startService).not.toHaveBeenCalled();
  h.provider.confirmStickyStop("worker-g44");
  await starting;
  expect(h.provider.anyOlderServiceCanBind(50)).toBe(false);
  expect(h.client.deleteSprite).not.toHaveBeenCalled();
});
```

Validation attempted on the current unmodified runtime:

```sh
npm test -- __tests__/worker-channel-sprites-close.test.ts __tests__/sprites-client.test.ts __tests__/sprites-provider.test.ts
```

All three suites failed in global setup before collecting tests. The initial sandbox connection failed with EPERM; an allowed retry outside the sandbox reached localhost and received ECONNREFUSED on port 5433. **No tests ran and no passing regression coverage is claimed.** The test matrix and snippets are proposed tests, not installed executable tests.

## Safe one-time recovery for run 248

This procedure retains the same run and Sprite. It is an operator runbook, not a record of actions already performed.

1. **Capture evidence and identity.** Resolve the actual Sprite from `runner_instances.sprite_name`; do not assume the name is `to-run-248` because pool assignments can use different names. Record run status, attempt, worker scope, generation, instance, operation, service name, SDK session ID and pending input IDs/status/order. Save relevant event/receipt/command timestamps and bounded per-service logs. Service definitions can contain credentials: keep raw captures restricted, and redact any report. Read-only SQL examples:

   ```sql
   SELECT id, status, attempt, worker_scope, sdk_session_id FROM agent_runs WHERE id = 248;
   SELECT * FROM runner_instances WHERE run_id = 248;
   SELECT id, status FROM run_inputs WHERE run_id = 248 ORDER BY id;
   SELECT created_at, type, payload FROM agent_events WHERE run_id = 248 ORDER BY created_at, id;
   ```

2. **Establish exclusive maintenance.** Pause all controller/dispatcher/reconciler replicas capable of mutating this run, including cleanup/retention sweeps, or use a maintenance helper that holds the existing `sprites:248` advisory lock through service inspection and stopping. The current process-local supervisor flag alone is insufficient. Do not hold that lock and then call a public provider method that tries to reacquire it on another connection. The helper must use an unserialized implementation/client under the held lock. Prevent new run-248 input delivery during this window without deleting already persisted inputs.

3. **Verify no legitimate replacement is working.** Re-read current identity under the maintenance fence. Inspect service states and port ownership. If a newer generation now has an active turn, abort this stale recovery plan and re-evaluate; the supplied observations are not a permanent authorization to stop a healthy new turn.

4. **Disable every owned worker service.** List `GET /v1/sprites/{actual-name}/services`; select exact `worker` and valid `worker-g<N>` names. Stop all of them for this maintenance operation, including G44, current failed services and failed services with restart timers. Do not touch other services. Use `POST .../services/{name}/stop?timeout=10s`, consume the complete NDJSON stream and retain errors. Re-read each definition until absent or explicitly stopped with no nonzero `next_restart_at`. Reissue bounded stops if a timer races the first stop. Fail the maintenance operation if any remain unknown/restartable; do not proceed to startup.

5. **Verify the physical boundary.** Re-list all worker services and inspect the listener inside the Sprite (for example, `ss -ltnp 'sport = :8787'`, if available). Require no listener and all definitions sticky-stopped/absent. Absence of a listener alone is insufficient. If 8787 remains occupied by an unrecognized process, identify its owner; do not kill an arbitrary PID. If the provider refuses a sticky stop, keep dispatch fenced and escalate the provider issue. Service-definition deletion after confirmed process stop is a possible operator fallback; never substitute Sprite deletion.

6. **Preserve and reconcile logical state.** Compare SDK session and pending input snapshots before allowing dispatch. Do not clear the SDK ID, restore a checkpoint, delete channel spools by hand, edit command payloads, or mutate input statuses. For a failed/parked run whose worker scope is already clear, normal `dispatchRun(248)` can allocate the next generation. For a stale preparing claim, use existing exact-generation startup-failure/reconciliation handling to retire the captured claim first; it may move the run to pending or failed according to its real retry count. If handling is already recorded/idempotently skipped, inspect that state rather than inventing another failure or bypassing guards with SQL.

7. **Start one patched controller and dispatch the existing work.** Release maintenance locks before calling public dispatch APIs. Use a reviewed admin invocation of `dispatchRun(248)` from the deployed control-plane environment and its normal pending-run pump. There is no run-resume PATCH endpoint in this checkout. Do not use `resumeExecutorRun(248)` or the session-resume route: that creates another executor run. Do not send another message merely to wake it; the original pending input is already the request to service. Treat `already-claimed` as a reason to inspect the winning generation, not permission to force a second worker.

8. **Verify recovery through the next park.** Expect a fresh generation/instance on the same Sprite, only that worker capable of binding 8787, authenticated hello and `run.start` acknowledgement, and the preserved SDK session in the start snapshot. Confirm the original pending input is assigned/processed once by normal turn receipts. After the next idle/parked phase, verify sticky stop with no restart timer and closed controller tunnel. Then restore the other controllers/dispatchers and normal retention policy.

If the patch is not yet deployed, stopping all stale services can restore availability temporarily but does not repair retirement. Keep the limitation explicit and do not call the incident resolved until another park/resume cycle succeeds with the invariant enforced.

## Counterarguments and remaining uncertainty

- **“Parked should keep its worker alive.”** This checkout's durable boundary returns from the worker driver. Retaining the filesystem is intentional; relying on an exiting process as the next input consumer is not supported by that path.
- **“A failed service currently owns no port.”** True at one instant, but irrelevant to a scheduled restart. The safety condition concerns future bind ability under supervision.
- **“Generation-specific names already solve this.”** They prevent a delayed service stop from targeting a newer service name. They do not provide distinct port namespaces.
- **“The lock alone prevents the race.”** It orders cooperating control-plane mutations and allocation. Sprite's internal restart timer does not acquire that lock.
- **“Checking twice proves it cannot restart.”** It detects some transitions, not arbitrary future behavior. The lasting guarantee depends on an explicit sticky stop and no other actor restarting retired definitions. Test the provider contract, including cold wake, and fail closed if it is contradicted.
- **“Why enumerate stopped rows/services?”** Current DB state is not a provider inventory, and the bug can leave false stopped records. Historical definitions must be found independently of that flag. Stop only worker definitions owned by this run's Sprite.
- **“The timeout indicates the wrong endpoint.”** Endpoint mistakes can cause that error too. Here the supplied bind errors plus G44 ownership establish port contention. The precise reason the stale listener did not yield an immediate credential/scope rejection rather than a proxy timeout needs tunnel/service logs; do not infer it from the final error text.
- Production still needs exact stop-stream evidence for G44/G45, restart counters/timestamps, provider runtime version, deployed revision, and proof of all external service writers. No unsupported backoff constants or exact stop failure chronology have been invented here.
