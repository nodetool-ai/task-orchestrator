# Box template build feedback — design

**Date:** 2026-07-17
**Closes:** [`BOX_TEMPLATE_UI_FEEDBACK_GAP.md`](../../../BOX_TEMPLATE_UI_FEEDBACK_GAP.md)
**Lands with:** the app-managed-template feature (`ensureTemplate()`,
`BOX_INTEGRATION_TASKS.md` B024-adjacent). This spec defines the event contract
that feature must emit and the UI that consumes it.

## Problem

When the app builds a Box template at dispatch time (fork blank box → clone →
`npm ci` → build worker → manifest → archive, ~10–15 minutes on first dispatch
or worker-SHA drift), the triggering run sits in a bare `pending` with no
run-visible activity. It is indistinguishable from a stuck queue, and the run
appears hung for the entire build.

## Approach

Treat the template build as an extra, expandable phase of the boot arc the user
already knows: extend `components/runs/startup-indicator.tsx` (the existing
pending → preparing → running stepper) rather than adding a new surface. Events
ride the existing `emitBoxEvent(runId, type, payload)` → `agent_events` → SSE
path — no new transport.

Scope is run-centric: the triggering run's experience, the pending reason for
runs deferred behind the same build, and nothing global. Out of scope: a
template registry surface, the metrics item (gap doc item 4), and pre-warming
builds ahead of dispatch.

## 1. Event contract (emitted by `ensureTemplate()`)

All events are keyed to the triggering run via `emitBoxEvent`:

| Event | Payload |
| --- | --- |
| `runner_box_template_building` | `{ workerSha, reason: "no-template" \| "sha-drift", steps: string[], estimatedSeconds: number }` |
| `runner_box_template_step` | `{ step, index, total }` |
| `runner_box_template_ready` | `{ templateId, durationMs }` |
| `runner_box_template_failed` | `{ step, error }` |

- The step names for v1 are `cloning-worker`, `installing-deps`,
  `building-worker`, `writing-manifest`, `archiving` — but the UI renders
  whatever `steps` array the `building` event carries, so the backend can
  add or reorder steps without a frontend change.
- Arrival of step *N* implicitly marks all steps `< N` done; there are no
  per-step completion events.
- `estimatedSeconds` is a static backend constant for v1 (900).

## 2. Pending reason (schema + run list)

Add a nullable `pending_reason` text column to `agent_sessions`, following the
existing `park_reason` precedent:

- Written whenever admission defers a run, using the reason strings `admit()`
  already produces (template build, capacity, account backpressure). The
  template-build defer writes `"Building box template…"`; runs deferred behind
  a build another run started write
  `"Waiting for box template build (started by run #N)"`.
- Cleared when the run is admitted.
- `components/runs/runs-index.tsx` renders it under the `SessionStatusPill`
  exactly as `parkReason` renders for parked runs; it stays live via the list's
  existing refresh mechanism.

This fixes the whole class of "pending is indistinguishable from stuck", not
only the template case.

## 3. Stepper UI (`startup-indicator.tsx` + `run-view.tsx`)

`run-view.tsx` reduces the template SSE events into a state object and passes
it to `StartupIndicator` as a new optional prop:

```ts
interface TemplateBuildState {
  phase: "building" | "ready" | "failed";
  steps: string[];
  stepIndex: number;        // -1 before the first step event
  startedAt: number;        // client receipt time of the building event
  stepStartedAt: number;    // client receipt time of the latest step event
  estimatedSeconds: number;
  durationMs?: number;      // set on ready
  error?: string;           // set on failed
  failedStep?: string;      // set on failed
}
```

While `phase === "building"` during `pending`, the "Queued for a runner" step
expands into a nested group:

- **Title:** "Setting up the box template" with an overall elapsed timer, plus
  one line of expectation-setting copy: *"One-time setup for this worker build —
  usually 10–15 minutes. Later runs skip this."*
- **Sub-steps** render as a checklist with human labels (`cloning-worker` →
  "Cloning worker repo", etc.; unknown step names fall back to the raw name),
  reusing the existing check/spinner/dot visual language. The active step shows
  its own elapsed time so the UI visibly moves even inside a long `npm ci`.
- **Escalating reassurance:** past 1.5× `estimatedSeconds`, a calm
  *"Still working — dependency installs can be slow on cold caches"* line
  appears.
- **On `ready`:** the group collapses to a checked
  "Template ready (12m 40s)" line and the normal boot arc (preparing → running)
  continues beneath it — one continuous story, no UI swap.
- **On `failed`:** the failing step gets an ✕ marker and the error message
  renders inside the indicator with *"Re-dispatching the run retries the
  build."* The run's existing failure handling owns the terminal state; there
  is no bespoke retry mechanism in v1.

The existing log-panel affordance (the "Boot log" button) is unchanged; if the
template build captures a bootstrap log the same button surfaces it, otherwise
the button simply isn't offered during the build phase.

## 4. Concurrent runs behind the same build

Only the triggering run receives the event stream. Other runs deferred by the
same build get the `pending_reason` line only — no stepper. This is an explicit
v1 limitation; if it bites, a follow-up can fan the events out to every
deferred run.

## 5. Error handling

- A `runner_box_template_failed` event puts the indicator in the failed state;
  the dispatch failure then flows through the existing run-failure path
  (status, transcript error), so the two surfaces agree.
- Missing/out-of-order events degrade gracefully: the reducer ignores `step`
  events before `building`, and a `ready`/`failed` event always wins over a
  stale step index.
- If SSE reconnects mid-build, the event route's existing tail-from-history
  behavior replays the template events, so the reducer rebuilds the correct
  state (elapsed timers restart from receipt time — acceptable drift).

## 6. Testing

- Unit tests for the event→`TemplateBuildState` reducer, including
  out-of-order and replayed-event cases.
- Component tests for the stepper's states: building (step 0), mid-build step
  advance, ready-collapse, failed.
- A backend contract test asserting `ensureTemplate()` emits
  `building → step(0..n, with index/total) → ready` in order, and
  `failed` with the failing step on error.
- A test that admission defer writes `pending_reason` and admit clears it.
