# GitHub-driven task lifecycle — design

**Date:** 2026-07-06
**Status:** approved (design), pending implementation plan
**Builds on:** the single-agent task flow (`2026-07-06-single-agent-task-flow-design.md`) — one implementor per task, PR + GitHub auto-merge, no reviewer.

## Problem

The task lifecycle carries a human/agent-review notion (`review` state) and a
generic `done` terminal that don't fit the single-agent, CI-gated flow. Task
state is also inferred indirectly (the webhook matches a PR to a run by
`run.prUrl`), so it drifts from GitHub reality. We want the task state to
**mirror the PR's real GitHub state**, updated as often as possible.

## Goals

1. Replace the lifecycle with GitHub-driven states: `todo → in_progress →
   testing ⇄ failing → passing → merged`. Remove `review` and `done`. `merged`
   is the only success terminal.
2. The implementor **always** links its PR to the task via a `set_task_pr` tool.
3. Task state is driven from the **real GitHub PR + CI state**, via webhooks
   (instant) and a frequent poller (as-often-as-possible), not from agent claims.
4. Every task-state change **wakes the parent** run.

## State machine

`TASK_STATES = [todo, in_progress, testing, failing, passing, merged, blocked, cancelled]`
(removed: `review`, `done`).

Transitions (`TASK_TRANSITIONS`):
- `todo` → in_progress, cancelled
- `in_progress` → testing, blocked, cancelled
- `testing` → passing, failing, merged, blocked, cancelled
- `failing` → testing, blocked, cancelled  *(agent pushes a fix → CI re-runs → testing)*
- `passing` → merged, testing, failing, cancelled  *(a new push can re-open CI)*
- `blocked` → in_progress, testing, cancelled
- `merged` → [] (terminal)
- `cancelled` → [] (terminal)

Semantics: `testing` = PR open, CI in progress. `failing` = latest CI concluded
failure — **the agent is always expected to fix it** (it is woken to do so).
`passing` = CI success / mergeable. `merged` = PR merged.

Naming note: the CI-failure state is named `failing` to parallel `passing`/`testing`.

## Design

### 1. State machine + migration
- Update `lib/types.ts`: `TASK_STATES`, `TASK_TRANSITIONS`, `STATE_LABEL`,
  `TASK_BOARD_STATES` (board columns become todo / in_progress / testing /
  failing / passing / blocked; merged is a closed column like done was).
- `tasks.state` is a plain `text` column (no DB enum), so no column-type
  migration — but add a **data migration** mapping existing rows:
  `review → testing`, `done → merged`. (A `review` task had an open PR → its CI
  state is re-derived by the sync on next poll; a `done` task is complete → the
  closest terminal is `merged`.)
- `taskCountsByState`, plan-close ("all tasks in {merged, cancelled}"),
  `applyMerge`, `pollMergedPrs`, and any `done`/`review` references update to the
  new set.

### 2. `tasks.pr_url` + `set_task_pr` tool
- Add a nullable `pr_url` column to `tasks` (+ migration).
- Add an orchestrator tool `set_task_pr(task_id, pr_url)`: validates the URL,
  writes `tasks.pr_url`, and transitions the task `in_progress → testing` (the PR
  now exists; CI is presumed starting). Idempotent (re-setting the same URL is a
  no-op beyond keeping state ≥ testing).
- The implementor persona prompt: **immediately after opening the PR**, call
  `set_task_pr(task_id, pr_url)` (before arming auto-merge). This is the
  authoritative task↔PR link; the webhook/poller no longer need to guess via
  `run.prUrl`.

### 3. GitHub → task-state sync (source of truth)
The agent never hand-sets testing/passing/failing/merged — the sync does, from
GitHub. A single pure mapper drives both entry points:

`prToTaskState(gh): TaskState` from `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup`:
- merged → `merged`
- open + latest checks failure → `failing`
- open + checks success (mergeable) → `passing`
- open + checks pending/running (or none yet) → `testing`
- closed-unmerged → `blocked` (PR abandoned; needs attention)

Applied by:
- **Webhooks** (`lib/github-webhook-handler.ts`): remap the existing merge/CI
  handling onto the new states via `prToTaskState` (merge → merged; CI
  completed → passing/failing). Matching prefers the new `tasks.pr_url` link,
  falling back to `run.prUrl` for legacy rows. A `failing` transition resumes
  the implementor to fix (reuse `handleNeedsFix`).
- **Poller** (generalize `pollMergedPrs` → `syncPrBackedTasks`): every
  ~`TASK_ORCH_PR_SYNC_MS` (default 20s), for every task with a `pr_url` in a
  non-terminal state, fetch GitHub state and apply `prToTaskState` (only writing
  on an allowed transition). This is the "as often as possible" belt that
  catches missed webhooks and drives state even without webhook delivery.

Both paths funnel through one `applyTaskStateFromPr(task, ghState)` helper so
webhook and poller stay consistent, and each state change emits its task event.

### 4. Parent waking on task-state change
Task-state transitions already emit `task.*` inbox events. Fold in the pending
"parents wake for all child events" change: a `supervisor`-audience copy of a
child's `task.*` / `gh.*` event now **wakes** the parked parent (today it's
informational-only). Implemented in `lib/inbox.ts`: after inserting the
supervisor copy, dispatch the parent if it's `parked`; and widen
`parkedRunsWithPendingEvents` (the pump belt) to include supervisor-audience
events. Bounded — these events (`gh.pr.merged`, `gh.ci.completed`, `task.*`) are
already coalesced/discrete, not high-frequency. The executor then re-scans
`list_tasks` on wake (already its model) and starts dependents once a dependency
reaches `merged`.

### 5. Agent role (implementor)
implement → open PR → `set_task_pr(task_id, pr_url)` → arm auto-merge → end.
On a `failing`-driven resume: fetch `gh_ci` logs, fix, push, end. The agent
never sets testing/passing/merged — GitHub state + the sync own those.

## Testing
- **State machine:** `prToTaskState` unit tests for each GitHub shape →
  merged/passing/failing/testing/blocked; `TASK_TRANSITIONS` allows the new
  edges and rejects `review`/`done`.
- **Migration:** a `review` row becomes `testing`, a `done` row becomes
  `merged`.
- **set_task_pr:** sets `pr_url` and moves in_progress→testing; rejects a bad
  URL; idempotent.
- **Sync:** `syncPrBackedTasks` moves a task testing→passing on a green PR,
  testing→failing on red, →merged on merge; skips terminal tasks; only writes
  on allowed transitions.
- **Webhook:** merge → merged, CI-fail → failing (+ implementor resume), matched
  via `tasks.pr_url`.
- **Parent wake:** a `gh.pr.merged` / `task.*` supervisor copy dispatches a
  parked parent; the pump belt returns parents with pending supervisor events; a
  terminal parent is not woken.
- Update existing tests referencing `review`/`done` to the new states.

## Risks / notes
- Large blast radius: `done`/`review` are referenced across repo/UI/tests. The
  data migration + a codebase sweep are required; the implementation plan
  decomposes this (state machine + migration; pr_url + tool; sync; webhook
  remap; parent wake; UI board).
- Auto-merge prerequisite (from the base spec) still applies: target repos need
  auto-merge + branch protection with required checks, no required approvals.
- Poller cost: one `gh pr view` per non-terminal PR-backed task per interval.
  Bounded by the number of in-flight tasks; `TASK_ORCH_PR_SYNC_MS` tunes it, and
  webhooks carry the fast path so the poll can stay modest.
