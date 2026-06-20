# Task attached run + Resolve-merge — Design

Date: 2026-06-19
Status: Approved (design); pending spec review

## Problem

A task accumulates several disconnected agent runs (one per "Run agent", one per
"Run review"), so context is split and there's no single place to continue work.
There is also no way to recover a PR that has fallen behind its base branch: when
GitHub reports the PR `CONFLICTING`, a human has to merge and resolve by hand.

We want:

1. **One persistent run per task** — a single session that carries context across
   implement → chat → review feedback → merge.
2. **One `Agent` button** on the task page that opens that attached run (creating
   it on first use), replacing the two existing "Run agent" / "Run review"
   buttons. The task's chat box feeds the same run.
3. **A `Resolve merge` action** that, in the *same* session, merges the PR's base
   branch into the PR branch, resolves conflicts via the agent, and pushes —
   updating the PR.

## Decisions (locked with the user)

- **One attached run per task**, shared by implement, chat, and merge.
- **`Agent` button is one-click** — no modal. First click creates the run
  (seeded with the implement prompt) and navigates to it; later clicks just open
  it.
- **The "Chat about this task" box feeds the attached run** (creating it if none),
  so the task page is an inline window into that one session.
- **Unified turn engine.** Implement / chat / merge are no longer distinct run
  types. Every turn runs through one engine; push + PR-open are **conditional on
  the branch having commits**, so a chat-only turn never creates an empty PR.
- **`Resolve merge` is visible only when GitHub reports `CONFLICTING`**, and
  merges the **PR's base branch** (from `gh pr view`), not a hardcoded `main`.
- **Turns land at `completed`** (terminal) so the plan-executor's `await_session`
  still resolves; resumability comes from letting `append` resume completed
  worktree runs (below).

## The attached run

A task's attached run is a single **worktree session**: `goal=<implement>`,
`cwdStrategy=worktree`, `toolsProfile=orchestrator,repo_write`, `taskId` set,
persona `implementor`. It owns the task's branch (`claude/<taskid>-<runid>`) and,
once there are commits, its PR. It behaves like a chat run that happens to have a
worktree and a git side-effect after each turn.

"Usable" attached run = any status except `closed`. A `closed` run is treated as
absent (the open-or-create endpoint mints a fresh one and repoints). A
`failed`/`cancelled` attached run is **resumable** (branch + worktree persist), so
it is reused, not replaced.

## The universal turn engine

This is the heart of the change. Today three code paths exist: `runImplement`
(worktree → turn → push → open PR → `completed`), `runReview` (`worktree_at_pr`,
read-only), and `append` (resume idle chat runs). The implement and append paths
collapse into one engine; review is unaffected (still its own worker / persona,
used by the executor's `start_review`).

`runs.append()` becomes the single resume/turn entry point. For an attached
worktree run it does:

1. **Lock** the run (existing per-run lock).
2. **Guard.** Refuse if `closed` or currently in flight
   (`running|preparing|pushing|opening_pr`). Allow `idle`, `completed`, `failed`,
   `budget_exhausted` for `cwdStrategy=worktree` runs — this is the relaxation
   that makes a finished session resumable. (Chat/`none` runs keep today's
   idle-only behavior.)
3. **Ensure cwd.**
   - No branch yet (first turn) → create it:
     `git worktree add -b <branch> <worktreePath> <baseBranch>`, persist
     `branch` + `worktreePath`. Transition the task `todo|blocked → in_progress`.
   - Branch exists but worktree missing → `prepareCwd` re-materializes it
     (existing logic).
4. **Persist the user/seed message, set status `running`, run the turn**
   (`runOneTurn`, unchanged).
5. **Git sync (conditional).** If the branch has commits ahead of its base
   (`git rev-list --count <base>..HEAD > 0`):
   - `git push -u origin <branch>`.
   - If `run.prUrl` is null → `openPr(...)`, persist `prUrl`, transition the task
     → `review`. Else the push updates the existing PR.
   - No commits → no push, no PR (pure conversation).
6. **Land `completed`**, persist tokens/cost/sdkSessionId, emit status.

`runImplement` is removed; its setup (worktree/branch create, task→in_progress) and
its tail (push, open PR, task→review) move into the engine as steps 3 and 5.
`runReview` and `runExecute` stay. `followUp()` (GitHub webhook) either delegates
to the engine or remains as-is — out of scope to change here, but it must not
regress.

Scope guard: push / PR-open apply **only** to `cwdStrategy=worktree`. Review
(`worktree_at_pr`, throwaway branch) and chat (`none`) never push.

## Data model — the attached-run pointer

- Migration `0017_tasks_attached_run_id.sql`: `ALTER TABLE tasks ADD COLUMN
  attached_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL;`
- Drizzle: add `attachedRunId` to `tasks` in `db/schema.ts`.

Helpers in `lib/repo`:

- `resolveAttachedRun(taskId): RunRow | null` — the pointed-to run, or `null` when
  unset / deleted / `closed`.
- `attachRunToTask(taskId, runId, { ifUnset?: boolean })` — set the pointer
  (no-op when `ifUnset` and already usable).

`runs.create()` for an implement run with a `taskId`, and the executor's
`agent.startSession()`, both call `attachRunToTask(taskId, run.id, { ifUnset:
true })`, so executor-spawned runs adopt the task's attached slot.

## Endpoints

- `POST /api/tasks/[id]/attached-run` → `{ runId }`. Open-or-create:
  `resolveAttachedRun`; if usable → return it. Else create the attached run (row
  only; the engine creates the branch on its first turn), set the pointer, and —
  because this is the one-click `Agent` path — kick the first turn with
  `buildImplementPrompt(task)`. Return the id.
- `GET /api/tasks/[id]/mergeable` → `{ mergeable: "CONFLICTING" | "MERGEABLE" |
  "UNKNOWN", baseRef: string | null }`. Shell `gh pr view <url> --json
  mergeable,baseRefName` when the task has a `latestPr`; any error → `UNKNOWN`.
  Kept off the server render so the page doesn't block on a network call.

The chat box posts to `POST /api/runs/[attachedRunId]/messages` (existing SSE
route) once the run exists; if none exists it first calls the open-or-create
endpoint **without** the implement seed (its first turn is the user's text).

## UI (`app/tasks/[id]/page.tsx` + components)

- **Remove** `RunAgentButton` and `RunReviewButton` usages. Delete the components
  if nothing else references them.
- **`Agent` button** (`components/task-agent-button.tsx`, client, one-click):
  `POST /api/tasks/[id]/attached-run` → `router.push('/runs/' + runId)`. Spinner
  while in flight. Label "Open agent" when `hasAttachedRun` (from the server
  page), else "Start agent".
- **Chat box** (`TaskChatBox`): on submit, resolve the attached run id (call
  open-or-create-without-seed if needed), then stream the message to
  `/api/runs/[id]/messages`, rendering inline. It becomes a thin view of the
  attached session rather than a spawner of standalone chat runs.
- **`ResolveMergeButton`** (`components/resolve-merge-button.tsx`, client): on
  mount `GET /api/tasks/[id]/mergeable`; render nothing unless `CONFLICTING` and
  an attached run exists. On click → `POST /api/runs/[attachedRunId]/messages`
  with `buildMergePrompt(baseRef)`, then `router.push('/runs/' + attachedRunId)`.
- **Inbox**: pin/highlight the attached run at the top so a return visit lands on
  it in one click. Other historical runs still listed below.

### Merge prompt — `lib/run-templates.ts: buildMergePrompt(baseRef)`

A user message posted to the attached run:

> The PR for this task has merge conflicts with its base branch `<baseRef>`.
> Fetch the latest base (`git fetch origin <baseRef>`), merge `origin/<baseRef>`
> into the current branch, and resolve every conflict so the result is coherent
> (not just deleting conflict markers). Run typecheck and lint where they apply and
> fix what you broke. Commit the merge with a clear message. Do not open a new PR.

The agent has `repo_write` (git + fs) in the re-materialized worktree; the engine's
git-sync step pushes the merge to the existing PR. `baseRef` comes from the
mergeability response, falling back to the repo default branch when null.

## Error handling

- Open-or-create failure → endpoint returns the `RepoError`; button shows it
  inline.
- `gh pr view` failure → `UNKNOWN` → button hidden (fail closed; no false merge
  prompt).
- Turn / push failure → existing run-view error surfacing; a failed `git push` is
  recorded as a system message and the run stays resumable.
- Missing branch on resume (deleted upstream) → existing `prepareCwd` error marks
  the run failed with an actionable message.

## Testing (vitest, pure-helper style where possible)

- `resolveAttachedRun` / `attachRunToTask`: set, unset, deleted-run, `ifUnset`
  no-op, `closed` treated as absent, `failed`/`cancelled` reused.
- `isResumableWorktreeRun(status, cwdStrategy)` predicate: true for
  idle/completed/failed/budget_exhausted worktree runs; false for `closed`,
  in-flight, chat, and review runs.
- `hasCommitsAheadOfBase` decision wrapper (pure, over a faked rev-list count):
  push/PR only when count > 0; PR opened only when `prUrl` is null.
- `buildMergePrompt(baseRef)`: includes the base ref; falls back when null.
- Mergeability parse: `gh` JSON → `{mergeable, baseRef}`; error → `UNKNOWN`.
- Integration smoke (DB fixtures, following `plan-executor.test.ts`):
  open-or-create returns the same id twice; a chat turn with no commits leaves
  `prUrl` null; a turn that commits opens exactly one PR and a second commit-turn
  reuses it.

## Out of scope

- Proactive/background conflict detection or polling.
- Collapsing the review *run type* — only the task-page buttons unify;
  `start_review` and the reviewer persona remain for the executor.
- Re-bucketing the `/runs` list so a between-turns attached run reads as "open"
  rather than "closed".
- Changing `followUp()` beyond not regressing it.
- Migrating historical multi-run tasks (pointer starts null; first interaction
  adopts or creates).
