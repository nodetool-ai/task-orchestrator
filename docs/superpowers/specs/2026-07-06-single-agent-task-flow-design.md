# Single-agent task flow (auto-merge, no reviewer) — design

**Date:** 2026-07-06
**Status:** approved (design), pending implementation plan

## Problem

A task is currently executed by **two** agents on **two** machines: the plan
executor spawns an **implementor** (`start_session` → worktree run → opens a PR
→ task to `review`), then spawns a **reviewer** (`start_review` → second
worktree run at the PR head → verdict), waits for the verdict, and only then
merges the PR itself (`gh_pr__pr_merge`). Two machines, two agent runs, and a
verdict round-trip per task — too much overhead.

## Goal

One agent, one machine per task: **implement → open PR → enable GitHub
auto-merge → stop.** CI is the merge gate (branch-protection required checks);
GitHub merges the PR automatically when checks pass. If CI fails, the existing
webhook path resumes the same run to fix it. No reviewer agent, no
executor-side merge step.

## What already exists (reuse, do not rebuild)

- **CI failure → auto-fix:** `handleNeedsFix` (`lib/github-webhook-handler.ts`)
  already matches a failing check to the PR-owning run, re-materializes its
  worktree, and resumes it with the failing `gh_ci` logs. A single agent already
  gets woken to fix CI.
- **PR merged → task done:** `applyMerge` already transitions the task to `done`
  (bypassCriteria) and records a `pr_merged` event on the merge webhook.
- **Inbox events:** `gh.pr.*` / CI events already land in the owning run's inbox.

## Non-goals

- Removing the plan **executor**. It stays as the DAG orchestrator (starts
  ready tasks, handles dependencies, retries a failed task). It only loses the
  review + merge choreography.
- Removing human PR-review handling: `gh_pr__pr_review`, the
  `review`-changes-requested autofix path, and `gh_ci` tools all stay. Only the
  **agent reviewer** goes away.
- Deleting the `<review>` goal execution plumbing (`runReview`,
  `driveDispatchedRun`'s `<review>` branch, `gh_pr_ro` profile). Once
  `start_review` is gone nothing creates a `<review>` run, so this plumbing is
  unreachable — left in place as dead code; a follow-up may delete it.

## Operational prerequisite

Target repos must have **auto-merge enabled** and **branch protection with
required status checks** (and NOT required human approvals — the PR author can't
approve their own PR, so a required-approval rule would stall auto-merge now
that there is no reviewer). `gh pr merge --auto` fails on a repo without
auto-merge enabled; that surfaces as a tool error the agent reports.

## Design

### 1. Auto-merge on `gh_pr__pr_merge`

Add an optional `auto?: boolean` to the existing `gh_pr__pr_merge` tool
(`lib/extensions/gh-pr.ts`). When `auto` is true, run
`gh pr merge <url> --auto --<method> [--delete-branch]` (method still required;
`squash` is the flow default). This asks GitHub to merge automatically once
required checks pass, instead of merging immediately. The PR-ownership lock
(`checkAndAcquirePrLock`) still applies. A non-zero `gh` exit (e.g. auto-merge
not enabled on the repo) is returned verbatim as an error result.

### 2. Implementor persona = the whole task lifecycle

Rewrite `lib/personas/implementor.ts`'s system prompt to own the end-to-end
flow:
1. Read the task body, parent plan, and acceptance criteria. Make the smallest
   change that satisfies the criteria; write tests first when reasonable; commit
   incrementally.
2. Open a PR whose body includes a **self-check of each acceptance criterion**
   (criteria are the implementor's checklist now, not a separate agent's
   verdict).
3. Enable auto-merge: `gh_pr__pr_merge(url, method="squash", delete_branch=true,
   auto=true)`. Then `report_result({status:"success", pr_url})` and END the
   run — do not poll CI.
4. **On resume with failing CI** (the webhook re-materializes the worktree and
   feeds the failing logs): use `gh_ci__ci_runs` / `gh_ci__ci_logs` to diagnose,
   fix, push, re-enable auto-merge if GitHub dropped it, and end again.

Profile: drop the now-unused `spawn` → `orchestrator,repo_write,gh_pr,gh_ci`
(add `gh_ci` so the same run can read its own CI logs on the fix resume).

### 3. Remove the agent reviewer

- Delete the `start_review` tool (`lib/orchestrator-tools.ts`).
- Remove the `reviewer` persona from the active set (`lib/personas/reviewer.ts`
  + `lib/personas/index.ts`). Do NOT delete existing `personas` rows or
  historical `<review>` runs — `seedRequiredPersonas` is insert-if-missing, so
  dropping it from the code set simply stops re-seeding; the prod row stays and
  FKs remain valid.
- Update tests that assert the persona set / tool set (seed-personas,
  personas-api, persona-repo, orchestrator-tools-validation, mcp-route,
  plan-executor, etc.) to the reduced set.

### 4. Executor persona = orchestrate only

Rewrite `lib/personas/executor.ts`'s prompt to drop all review/merge steps:
- For each ready task (dependencies all `done`): `start_session(task_id)`. The
  implementor now owns implement → PR → auto-merge → CI-fix.
- A `child.result(success)` means "PR open, auto-merge armed" — **not** task
  done. The task completes when its PR merges: the `gh.pr.merged` event (→
  `applyMerge` sets the task `done`) is the trigger to start dependents (they
  branch off the freshly-merged default branch).
- Keep the watchdog/retry discipline: a task whose implementor `child.died` /
  `child.exception(recoverable=false)` gets one fresh `start_session` retry,
  then `transition_task → blocked` + note.
- Remove: `start_review`, `gh_pr__pr_merge`, and all verdict handling from the
  prompt. The executor no longer merges anything.

## Data flow

```
executor: start_session(task)            (one worktree run, one machine)
  └─ implementor: implement → PR → gh pr merge --auto --squash → report_result → END
        · CI passes  → GitHub auto-merges → webhook applyMerge → task=done
        │                                        └─ executor wakes on gh.pr.merged → starts dependents
        · CI fails   → webhook handleNeedsFix → resume implementor with logs → fix → push → END
```

## Testing

- **gh_pr__pr_merge auto:** unit test that `auto=true` produces
  `gh pr merge <url> --auto --squash --delete-branch` (assert the `gh` argv via
  the existing gh-pr test harness), and `auto` omitted/false keeps today's
  immediate-merge argv.
- **Persona/tool set:** update the persona-count and tool-registry tests to the
  set without `reviewer` / `start_review`; assert `start_review` is no longer
  registered.
- **Implementor/executor prompts:** these are behavioral; assert profile strings
  (`implementor` → `orchestrator,repo_write,gh_pr,gh_ci`; executor unchanged from
  its cwd=none profile) and that the prompts contain no stale tool references.
- Existing webhook tests (`events-webhook`) for merge→done and CI-fail→autofix
  already cover the reused paths; confirm they still pass unchanged.

## Risks / notes

- **Auto-merge depends on target-repo config** (prerequisite above). If a repo
  lacks it, `--auto` errors and the task stalls with a clear message; the
  operator enables auto-merge or the executor blocks the task after retries.
- **No independent review.** CI is the sole automated gate; acceptance criteria
  become advisory (implementor self-check). This is the accepted trade-off.
- **`child.result` ≠ done.** The executor prompt must key task completion on
  `gh.pr.merged`, not the implementor's success result — otherwise it would
  start dependents against an unmerged base.
