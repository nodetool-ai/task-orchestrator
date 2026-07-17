# Gap — no UI feedback for Box template provisioning

**Date:** 2026-07-17
**Related:** [`BOX_INTEGRATION_DESIGN.md`](BOX_INTEGRATION_DESIGN.md), [`BOX_INTEGRATION_TASKS.md`](BOX_INTEGRATION_TASKS.md) (B024 template CLI)
**Status:** closed 2026-07-17 — feedback shipped (04b25ec..b46c44a), app-managed provisioning shipped alongside (specs `2026-07-17-box-template-build-feedback-design.md`, `2026-07-17-box-app-managed-template-design.md`).

## Context

Today a Box template is built out-of-band by `scripts/install-box-template.sh`
and its id is pinned in `TASK_ORCH_BOX_TEMPLATE_ID`. The planned change makes
the **app** own the template lifecycle: on a box dispatch, `ensureTemplate()`
builds a template (fork blank box → clone worker@sha + agent repo → `npm ci` →
`build:worker` → write manifest → archive) when none matches the current worker
build SHA, then forks the run box from it. The build is slow — a clone, two
`npm ci` runs, a worker build, and a snapshot archive: on the order of **10–15
minutes** for the *first* dispatch (and again whenever the worker SHA drifts).

## The gap

During that first build the triggering run is deferred to the existing
admission `pending` state, and **nothing tells the user what is happening**:

- The build emits no run-visible events, so the run's live event stream
  (`app/api/runs/[id]/events/route.ts` → `components/runs/run-view.tsx`) shows
  no template activity.
- The run shows a bare `pending` with no reason — indistinguishable from
  capacity backpressure or a stuck queue.
- There is no template-state surface anywhere (the metrics route reports
  `runner_instances` by state, but there is no `box_templates` registry yet, let
  alone a UI for it).

Net effect: a first box run appears hung for ~15 minutes.

## What already exists (the plumbing is there)

- **Run status** (`agent_sessions.status`: `pending → preparing → running → …`).
- **A live SSE event stream** per run that tails `agent_events` / `agent_messages`
  and renders in `run-view.tsx`.
- **`emitBoxEvent(runId, type, payload)`** already writes Box lifecycle events
  (`runner_box_forking`, `runner_box_ready`, …) into `agent_events`, so they
  already ride that stream. Template events can reuse this path with **no new
  transport**.

## Proposed fix (fold into the app-managed-template feature)

1. **Emit template lifecycle events keyed to the triggering run** via
   `emitBoxEvent`: `runner_box_template_building`, `runner_box_template_step`
   (`cloning-worker` / `installing-deps` / `building-worker` / `writing-manifest`
   / `archiving`), `runner_box_template_ready`, `runner_box_template_failed`.
2. **Set a pending detail/reason on the deferred run** (reuse the admission-defer
   reason string) so the run list/view reads "Building box template…" rather
   than a bare `pending`.
3. **Render the new event types in `run-view.tsx`** as a compact progress line.
4. *(Optional)* Report `box_templates` state on the metrics/runners surface
   (`app/api/metrics/route.ts` already reports `runner_instances` by state).

Desired result: the first dispatch shows a live
"Building box template → cloning → installing deps → building worker →
archiving → ready", then the run proceeds; later dispatches skip straight
through.

## Scope note

This gap is only reachable once app-managed template provisioning lands; until
then `TASK_ORCH_BOX_TEMPLATE_ID` is pre-set and no build happens at dispatch
time. Items 1–3 are core to shipping the feature usably; item 4 is a follow-up.
