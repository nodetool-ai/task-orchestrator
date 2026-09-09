# CodeAct with QuickJS-NG

Status: proposed implementation plan, 2026-09-07. This document proposes the migration; it does not enable CodeAct or create implementation runs.

The intended outcome is that agents perform most tool work by writing JavaScript against a complete application SDK inside a QuickJS sandbox. They can fetch data, filter it, combine operations, and return a concise result in one model tool call. Every underlying operation still runs through the application's services and permission checks.

“All app functionality” means every supported product operation has a sandbox API, including functionality currently available only through REST, CLI, or UI actions. Availability within an individual run remains subject to its identity, scope, profile, and runtime. Administrative operations are part of the SDK, with explicit administrative capabilities; they are not silently granted to every agent.

## Current architecture and integration points

| Existing code | Role in the migration |
| --- | --- |
| `lib/orchestrator-tools.ts` | Existing repository, plan, task, note, criterion, attachment, and session operations; retain names as compatibility aliases. |
| `lib/worker/server-tools.ts` | Server registry also includes events, planning, spawn, memory, welfare, and terminal PR operations. Reuse executors and extend coverage. |
| `lib/extensions/types.ts`, `lib/worker-runtime/tools.ts` | Existing `ToolInvoker` seam forwards worker calls over the channel; keep workers database-free. |
| `lib/worker-channel/snapshot.ts`, `tool-invoke.ts`, `repository.ts` | Authorized catalogue, server-side dispatch, receipts, and replay. Extend these for correlated CodeAct subcalls. |
| `lib/profiles.ts` | Controls mounted capabilities and `serverSafe`. CodeAct must preserve these decisions for each underlying operation. |
| `lib/agent-backend/collect.ts`, `types.ts` | Backend-neutral tools, prompt transforms, interceptors, and lifecycle hooks. Insert CodeAct after collection without discarding hooks. |
| `lib/agent-backend/{pi-backend,postgres-turn,claude-backend,codex-backend}.ts` | Four execution paths need the same CodeAct surface, including server-runtime persona chats. |
| `lib/extensions/{gh-pr,gh-ci,repo-read,brave-search}.ts` | Additional capabilities have executors outside the server registry. Account for execution location rather than forwarding every tool to Postgres-backed dispatch. |
| `app/api/**/route.ts`, `cli.ts`, application services | Source inventory for functionality beyond today's tool catalogue, especially schedules, runs, chats, configuration, and administration. |
| `app/api/mcp/route.ts` | External MCP clients currently see `ORCHESTRATOR_TOOLS`; preserve that contract while internal agents move to CodeAct. |
| `lib/tool-grouping.ts`, `lib/sdk-message.ts`, transcript components | Display a CodeAct execution and its individual operations without flattening everything into an opaque code result. |

Read `SCHEMA.md` and `docs/agent-caveats.md` before implementation. Some schema documentation retains historical session terminology; use current migrations and services when adding persistence.

## Runtime decision

Use **QuickJS-NG compiled to WebAssembly**, hosted through `quickjs-emscripten-core` with an explicitly selected NG variant. Do not rely on the binding package's default engine. Pin the binding, variant, and underlying NG revision, and record artifact provenance. The binding documents NG variants and configurable WASM loading. [Binding documentation](https://github.com/justjake/quickjs-emscripten#quickjs-ng)

Run guest evaluation in a dedicated Node worker thread. Each execution receives a fresh WASM instance, runtime, and context; cache compiled WASM code where supported, never guest state. The main worker or pipe process brokers application requests. This keeps guest computation off the channel/control-plane event loop, with an external deadline that can terminate the execution thread. A thread is a scheduling and termination boundary; isolation from host objects comes from WASM and the narrow bridge.

QuickJS provides runtime memory limits, stack limits, and an interrupt callback. Its contexts can share a runtime heap, so use separate runtimes for separate executions. Accept source only: upstream explicitly warns against untrusted QuickJS bytecode. [QuickJS-NG C API](https://quickjs-ng.github.io/quickjs/developer-guide/intro/)

Start with ordinary guest promises and an explicitly driven job queue. The binding requires pumping pending jobs after host promises settle; waiting on a guest promise alone can deadlock. Use its synchronous engine variant with promise-returning host callbacks; Asyncify is unnecessary for this API. Validate the exact NG variant in the first milestone. [Promise integration](https://github.com/justjake/quickjs-emscripten#promises)

Do not execute model source using Node `eval`, `vm`, dynamic host imports, or the stock `qjs` CLI. Do not expose `process`, `require`, host `fetch`, filesystem bindings, `std`, `os`, WASI preopens, native modules, credentials, or raw database clients. Guest dynamic imports fail except for explicitly bundled SDK modules. Shell and file operations, when authorized, are explicit worker-side capabilities operating in the run's validated worktree.

## Agent-facing API

The primary model tool is `codeact_execute({ code, title })`. Code is JavaScript interpreted as an async function body, allowing top-level `await` and `return`. TypeScript declarations describe the SDK but TypeScript syntax is not evaluated in v1.

Expose these globals:

- `app`: versioned, namespaced application SDK with promise-returning methods.
- `tools`: compatibility aliases for existing authorized tool names during migration.
- `catalog.search({ query })` and `catalog.describe({ names })`: bounded discovery of authorized methods, input/output schemas, examples, permissions, and effect semantics.
- `output.text(value)` and `output.image(handle)`: explicit model-visible output. The final return value is also visible.
- `console.log`: bounded diagnostic output attached to the execution.

Also register a small native `codeact_catalog` discovery tool so models can discover method contracts before their first execution. Start prompts with namespace summaries and a few examples, not every operation schema. Generate declarations and documentation from the same descriptors that generate SDK methods.

Illustrative target API, to be finalized with the coverage inventory:

```javascript
const page = await app.tasks.list({ planId, state: "todo", limit: 50 });
const readiness = await Promise.all(page.items.map(async task => ({
  id: task.id,
  dependencies: await app.tasks.dependencies({ taskId: task.id })
})));
return readiness
  .filter(item => item.dependencies.every(dep => dep.state === "done"))
  .map(item => item.id);
```

The executor bounds concurrency even when guest code uses `Promise.all`. Mutations execute in the order they are individually awaited; independently submitted mutations have no implicit ordering or transaction. Multi-step atomic operations must be explicit service operations.

Keep native tools for parking, asking a parent/user, raising an issue, and reporting completion wherever current turn-control behavior requires it. These operations also have SDK methods. A successful terminal/parking call closes the execution in the host, prevents further dispatch, and propagates the existing turn effect; catching a guest exception cannot undo it. Long-lived waiting uses the existing event/run system rather than keeping a QuickJS VM alive.

Retain backend-native coding tools initially. Expose equivalent worktree file, search, patch, and process operations through the SDK, then prefer CodeAct for batches. Native interactive process controls may remain where they are a better fit. “Most tool calling” does not require replacing model providers, SDK conversation persistence, or every specialized native tool.

## Complete application coverage

Build an operation inventory across routes, CLI commands, tools, and UI/server actions. Each entry records a stable operation ID, implementing service, schema, execution location, identity requirements, effects, and sandbox method. Route count alone is not a completeness measure: aliases and callbacks may represent the same product operation.

| SDK namespace | Required coverage |
| --- | --- |
| `app.repositories` | List, inspect, create, update, delete, repository associations and applicable configuration. |
| `app.plans`, `app.tasks` | CRUD, dependencies, state transitions, assignment, PR association, mergeability, attached runs, notes and criteria. Preserve state-machine gates. |
| `app.attachments` | List, inspect, upload, retrieve, delete; text, images, and binary artifacts through bounded handles. |
| `app.runs`, `app.sessions`, `app.chats` | Create, inspect, list, message, resume, cancel, logs/events, overview, inbox, child runs and results. Long work returns a run or job identifier. |
| `app.planning`, `app.events`, `app.timers` | Planning stages and approvals, subscriptions, wakeups, questions, reporting and parking. Preserve existing lifecycle semantics. |
| `app.personas`, `app.memories`, `app.laurels` | Persona configuration, scoped memory search/write/delete, recognition and delivery behavior. |
| `app.schedules` | List, get, create, update, pause, resume, run now, delete through `lib/schedules.ts`. Preserve owner and launch reservation behavior. |
| `app.github`, `app.web` | PR and CI operations, search and existing web capabilities with current credentials held by the host. Preserve read-only/review/merge distinctions. |
| `app.workspace` | Authorized file reads/writes/patches, search, git helpers and process execution in the worker worktree; absent on server-runtime runs. |
| `app.environments`, `app.providers` | Existing environment build/configuration and provider inspection/control operations, with asynchronous job status where needed. |
| `app.messaging` | Discord bot configuration, verification/identity workflows, supported messaging actions, and conversation management. Preserve ownership and recipient authorization. |
| `app.admin`, `app.auth`, `app.diagnostics` | Supported user/token administration, provider login initiation/status/revocation, profiles, health, metrics and operational diagnostics, under appropriate capabilities. |

Administrative parity is workflow parity: for example, a login method can return a device-login instruction or secret-input handle. Tokens/passwords enter through a secure host-owned input flow; reads return status and redacted metadata, not bearer material. Guest code can initiate authorized configuration workflows without receiving reusable credentials.

Classify infrastructure-only endpoints such as OAuth callbacks, webhooks, worker bundle delivery, and protocol handshakes explicitly; map their user-facing actions where applicable rather than exposing a generic HTTP route invoker. Record every exclusion and its reason in the inventory. Completion requires no unexplained gaps and no product operation omitted just because it lacks a current tool.

## Shared operation registry and dispatch

Introduce `lib/app-api/` for operation descriptors, schemas, namespace mappings, and service adapters. Keep transport-neutral descriptors importable without database dependencies; load server executors only on the control plane. Reuse TypeBox/JSON Schema and existing validation infrastructure, adding output schemas and structured results where missing.

Each descriptor contains:

- Stable ID, SDK path, legacy aliases, description, version, input and output schemas.
- Execution location (`control-plane` or `worker`), required capabilities and `serverSafe` classification.
- Effect category (read, mutation, external effect, lifecycle), timeout, cancellation support, and idempotency/reconciliation behavior.
- Redaction, pagination, result-size and artifact policies.

Move any business logic found inside routes into shared services. REST, CLI, existing tools and CodeAct call those same services; do not duplicate state transitions or schedule rules in SDK wrappers. Existing text-only tools can remain compatible adapters, while SDK methods return structured values rather than parsing human-oriented messages.

Dispatch flow:

```text
Model -> codeact_execute -> QuickJS-NG execution thread
                              |
                         bounded host RPC
                              |
                 operation dispatcher + policy + interceptors
                      /                         \
           worker-local executor           existing channel
           (validated worktree)                 |
                                     control-plane services
```

Authorize each subcall, not just `codeact_execute`. Generate the guest catalogue from the authorized operation set. Independently validate method IDs, arguments, current permissions, resource access, and lifecycle state in the host. Derive run, user, author and ambient scope from trusted execution context; an explicit target ID is still checked against that context. This work must audit resource authorization rather than assume current tool-name allowlisting provides full resource isolation.

Run existing canonical-name interceptors on every subcall, including argument transformations and planning restrictions. The generic executor name must not bypass those rules. Resolve current planning stage for each call so a batch cannot retain permissions from an earlier stage.

Preserve `RunStart.policy.allowedTools` compatibility and introduce a versioned operation catalogue if needed. Do not authorize arbitrary descendants merely because the outer executor is allowed. Server-runtime calls use the same policy dispatcher through an in-process service adapter, with no direct host filesystem access. Workers continue using `WorkerSession`; never add a worker-to-database fallback.

## Execution lifecycle, limits and recovery

Use a fresh VM for each call in v1. No implicit REPL globals or heap snapshots survive. Persist results through application entities, artifact handles, or explicit JSON execution outputs; resumable agent conversations use existing backend persistence. Never replay source code automatically to reconstruct VM state.

Proposed starting limits, configurable downward by policy and tuned in the spike:

| Resource | Initial limit |
| --- | --- |
| Source | 64 KiB |
| QuickJS heap / stack | 64 MiB / 512 KiB |
| Guest compute / total execution | 5 seconds / 60 seconds |
| Underlying operations | 100 per execution, 8 concurrently in flight |
| JSON request or inline response | 1 MiB per operation, bounded depth and item count |
| Model-visible text including logs | 64 KiB per execution |

Track active engine time separately from host waits. Apply interrupts during evaluation, serialization and promise jobs, and bound job pumping so it cannot starve cancellation. Add per-run and global admission limits; one agent cannot create unbounded execution threads. Cap queued requests and aggregate transferred bytes as well as individual messages. Set WASM memory ceilings in addition to QuickJS allocator limits and discard each instance after use.

When the async body settles, drain already-dispatched operations within the deadline and report any failures; reject new dispatch from detached continuations. Track unhandled rejections and in-flight operations explicitly so an unawaited mutation cannot silently outlive a successful tool result. Dispose all handles, promises, context and runtime in every exit path. Drop late callbacks using execution-generation checks.

Extend the invoker context with host-generated `executionId`, `subcallId`, deadline and abort signal. Today the worker invoker creates a fresh UUID for each call; add a path that preserves the recorded subcall identity across transport retransmission. Guest code cannot choose another execution's receipt identity.

Persist execution metadata and per-operation receipts before results are exposed. Reuse channel ordering, durable spool, incarnation fencing, and existing result replay. A whole execution is not a transaction. A timeout or cancellation stops new work, aborts cancellable host work, and reports completed, failed, cancelled, and unknown operations separately.

Audit the crash window between a side effect and its receipt: existing envelope deduplication alone is not proof of exactly-once effects. For database mutations, commit the idempotency record with the mutation where possible. For external APIs, use provider idempotency keys or operation-specific reconciliation. Mark ambiguous outcomes as unknown and reconcile before retrying; never automatically rerun an entire script containing writes. A model-submitted new execution is new work, not transport replay.

Long operations return durable job/run IDs with status methods. Cancellation does not imply rollback of an already committed change. Recovery records must make that visible to the model and user.

## Results and observability

SDK methods resolve schema-validated data and reject with bounded structured errors (`code`, `message`, `operationId`, `retryable`, and safe details). Preserve text/image content blocks for legacy tools. Binary data and oversized JSON use scoped, expiring artifact handles with read/slice/export methods; image output resolves through the host into existing multimodal content blocks.

Store source, engine/SDK version, start/end status, output, resource usage, and operation trace under the owning run's existing access controls. Redact sensitive inputs and outputs before persistence. Render the code block and expandable subcalls with durations, outcomes, links to created entities, and clear partial completion. Keep raw bulk results out of model context unless requested.

Measure execution startup time, guest compute, host latency, operation count, schema/output tokens, failures, interruptions, and task completion. Avoid double-counting subcalls as additional model turns.

## Implementation work packages

These are proposed tasks, not claimed or completed task-system entries. Create them under an accepted plan when implementation begins, with the listed dependencies and criteria.

| Package | Depends on | Deliverables and acceptance criteria |
| --- | --- | --- |
| 1. Inventory and baseline | — | Checked-in operation coverage manifest; all surfaces classified; representative direct-tool workloads and baseline measurements recorded. |
| 2. QuickJS-NG spike | — | `lib/codeact/` prototype and build fixture; verified NG provenance; async RPC, job pumping, limits, disposal, thread termination; load packaged WASM locally and from standalone worker artifacts without network access. |
| 3. Shared API and policy | 1 | `lib/app-api/` descriptors and dispatcher; structured outputs; legacy aliases; generated discovery/types; service extraction; per-operation authorization/interceptors tested. Existing direct callers retain behavior. |
| 4. Production execution bridge | 2, 3 | `codeact_execute`, catalogue, output/handle bridge, execution receipts, cancellation, subcall tracing and recovery. No direct database imports enter the worker bundle. |
| 5. Pi and server-chat integration | 4 | Wire neutral collection into pi worker and postgres-turn paths; preserve hooks, budgets, planning, parking and `serverSafe`; transcript UI shows subcalls and partial outcomes. |
| 6. Complete API coverage | 3, 4 | Implement every remaining inventory operation, including schedules, administration and configuration workflows; parity and capability tests cover each family. |
| 7. Claude and Codex integration | 4 | Expose the same neutral executor through existing SDK/MCP bridges; validate underlying interceptors, images, errors, cancellation, resume and retained native coding tools. |
| 8. Packaging, evaluation and cutover | 5, 6, 7 | All deployed runner forms and server pipe pass smoke tests; benchmark gates pass; enable CodeAct as the default app-tool surface and document rollback. |

Proposed new modules include `lib/codeact/{runtime,execution-thread,bridge,catalog,output}.ts` and `lib/app-api/{types,registry,dispatch}.ts`. Add persistence through normal migrations, update worker protocol schemas compatibly, and change `scripts/build-worker-standalone.mjs` and `lib/worker-bundle.ts` to include the pinned WASM artifact. Keep service executors out of the guest and worker bundles.

## Verification and rollout gates

Run focused tests during each package, then the existing typecheck, full test suite, application build, and both worker build commands before cutover. Exercise these behaviors explicitly:

- Same read/mutation result and state-machine errors through direct tools and CodeAct; forbidden profile and resource access denied on both paths.
- Server persona cannot invoke worktree, merge/approve, raw host, or administrative capabilities by guessing names, aliases, or arguments.
- Infinite loop, recursion, allocation storm, promise storm, huge output, hostile serialization, unknown imports, malformed RPC and cross-execution handle use remain bounded.
- Sequential and parallel reads, failed branches, unawaited calls, image/artifact handling, runtime reuse attempts, cancellation and late responses are deterministic.
- Planning and lifecycle calls stop further operations even if guest code catches exceptions; stage restrictions are checked after preceding mutations.
- Disconnect/reconnect, duplicate delivery, worker restart, controller crash before/after side effects, and orphan recovery do not blindly repeat writes.
- Existing channel, profile, planning, backend, schedule, worker bundle and standalone bundle suites remain green, including `worker-websocket-e2e` and the worker runtime bundle guard.
- Local, Docker and configured remote runners load WASM and keep their channel responsive under guest load; server-runtime chat behaves the same without a worktree.

Use a temporary per-run `toolCallingMode: direct | codeact`, resolved at run creation and persisted for resume. Roll out to controlled evaluation runs first, then make CodeAct the default for app operations across supported backends. Keep legacy direct MCP compatibility for external clients; do not remove established APIs merely because internal prompts change.

Benchmark at least task triage, plan creation with criteria, schedule management, run/CI investigation, memory search, image attachment inspection, and a coding workflow. Proposed cutover targets: at least 80% of eligible app-tool interactions go through CodeAct, at least 30% fewer tool-related model-context tokens on multi-operation workloads, no more than 10% p95 end-to-end latency regression, and completion quality at least equal to baseline. Fix baselines and sample sizes before measuring; treat these as targets to verify, not promised gains. Authorization and recovery failures block cutover regardless of averages.

Rollback changes the default for new runs to direct mode. Preserve recorded execution/subcall outcomes and explicitly reconcile interrupted writes. Existing runs keep their recorded mode or resume through a deliberate compatible transition; do not fall back to direct tools by replaying a failed script.

The migration is complete when application coverage is accounted for, all supported execution paths can use the SDK, sandbox and recovery tests pass, and measured workloads meet the cutover gates.
