# cwd=none tool policy + lightweight executor — design

**Date:** 2026-07-06
**Status:** approved (design), pending implementation plan

## Problem

Run workers currently mount every built-in filesystem/shell tool
(`Read/Write/Edit/Bash/Grep/Glob/LS`) unconditionally: the Claude backend runs
`permissionMode: "bypassPermissions"` with the `claude_code` preset, and the
`allowsRepoWrite` flag that `resolveProfiles()` computes is discarded in
`runOneTurn` (`lib/runs.ts:2710`). There is no built-in-tool gating today.

For a run with **no checkout** (`cwd_strategy: "none"`) those tools are:

- **useless** — there is no repository or worktree for them to operate on; and
- **dangerous** — `Bash` is arbitrary shell. It is the blocker for ever driving
  such a run in-process in the server container (where `DATABASE_URL`, the
  worker-token signing secret, and provider keys live).

The plan **executor** (`<execute>` goal, `executor` persona) is meant to be a
pure control plane — its own prompt already says *"You write no code yourself —
you spawn and supervise… between wakes you hold no worker, no container, no
tokens."* Yet it currently defaults to `cwd_strategy: "repo"` (a full checkout)
and its prompt leans on `Read/Grep/Glob` against that checkout. We want it
repo-less and hardened so it delegates **all** repo-touching work to workers.

## Goals

1. Define and enforce a tool policy for `cwd_strategy: "none"` runs.
2. Make the executor lightweight: default it to `cwd_strategy: "none"`, prune
   its profile, and rewrite its prompt to match the reduced tool surface.
3. Establish the architectural rule that separates in-server-eligible runs from
   worker-only runs.

## Non-goals

- Actually moving the executor (or any run) to execute **in-process in the
  server container**. This change only makes such runs *eligible* (repo-less +
  hardened). The dispatch-placement decision is a separate follow-up.
- Changing the reviewer or implementor. They keep their checkouts and stay
  workers (see the rule below).

## The architectural rule

> **`cwd_strategy: "none"` = the in-server-eligible, lightweight class**
> (executor, chat, planner). **Any run that materializes a checkout —
> reviewer (`worktree_at_pr`), implementor (`worktree`) — stays a worker.**

Why the PR **reviewer** stays a worker (the motivating question):

1. **It needs a checkout.** It runs `cwd_strategy: "worktree_at_pr"` and reads
   the PR's source with `Read/Grep/Glob`. Repo access *is* the job.
2. **It handles untrusted code.** The persona already flags "checks out an
   untrusted third-party PR." Even read-only, that belongs on an isolated
   Machine with no DB/secret env — not the single `--ha=false` server container.

The executor, by contrast, needs nothing local: its only PR grounding is
`gh_pr__pr_view` / `gh_pr__pr_diff`, which shell out to `gh … <PR-URL>` (the
GitHub API resolves the repo from the URL — no checkout required).

## Design

### 1. cwd=none tool policy

When `cwd_strategy === "none"`, disallow the filesystem/shell family:

```
Read, Write, Edit, Bash, Grep, Glob, LS
```

Everything that does not need a filesystem stays available:

- extension-mounted tools: orchestrator (`task_orch__*`), `gh_pr__*`,
  `spawn__*`, events/timer, persona memory;
- built-ins that are cwd-independent and safe: `WebFetch`, `WebSearch`,
  `TodoWrite`, `Task`.

For `worktree` / `worktree_at_pr` / `repo` runs the denylist is empty (current
behavior preserved). `allowsRepoWrite` folds into the same resolver as a
cleanup so the flag stops being dead.

### 2. Enforcement seam

- Add `disallowedBuiltins?: CanonicalTool[]` to `RunTurnArgs`
  (`lib/agent-backend/types.ts`). Canonical names (`lib/builtin-tools.ts`) keep
  it backend-agnostic.
- Compute the list in `runOneTurn` from the run's `cwd_strategy` (+
  `allowsRepoWrite`) via a small pure resolver, e.g.
  `disallowedBuiltinsFor(cwdStrategy, allowsRepoWrite): CanonicalTool[]`.
- **Claude backend:** map canonical → TitleCase and pass SDK `disallowedTools`.
- **pi backend:** filter the offered built-in set by the same list.
- **Backstop:** one shared `PreToolUse` deny so a disallowed built-in that
  somehow gets invoked hard-fails on either backend (defense in depth).

### 3. Executor becomes repo-less

- **`create()` default:** flip the `<execute>` branch from `"repo"` → `"none"`.
  cwd is goal-keyed and executor ↔ `<execute>` is 1:1, so this makes the
  executor default to `none` without a per-persona mechanism. An explicit
  `input.cwdStrategy` still overrides.
- **Profile:** drop the now-redundant `repo_read` marker →
  `orchestrator,gh_pr,spawn`. (`repo_read` only set `allowsRepoWrite=false` and
  gated built-ins that `none` already removes.)
- **Prompt rewrite (required, not cosmetic):** remove the `Read / Grep / Glob`
  bullet and the "Read/Grep the repo to understand it" guidance; replace with:
  *you hold no checkout — ground PR decisions via `gh_pr__pr_view` /
  `gh_pr__pr_diff`, and delegate any code inspection to a child run.* Leaving
  the old text would instruct the agent to reach for tools it no longer has.

## Testing

- **Resolver unit test:** `none` → `[Read, Write, Edit, Bash, Grep, Glob, LS]`;
  `worktree` / `worktree_at_pr` / `repo` → `[]`.
- **Claude backend test:** `disallowedBuiltins` surfaces as `disallowedTools`
  (TitleCase) in the SDK `query` options.
- **PreToolUse backstop test:** a `Bash` call under a `none` policy is denied.
- **create() test:** an `<execute>` run defaults to `cwd_strategy: "none"` and
  profile `orchestrator,gh_pr,spawn`; an explicit override still wins.

## Risks / notes

- The executor loses direct repo reading. Mitigated: `gh_pr__pr_diff/pr_view`
  cover PR grounding (API-based), and code inspection is delegated to children —
  which is the intended shape.
- `gh` in a repo-less run relies on the ambient `gh`/GitHub token in the run's
  env (already present today); the URL form needs no local remote.
- Keep the denylist centralized in one resolver so the policy has a single
  source of truth across both backends and the PreToolUse backstop.
