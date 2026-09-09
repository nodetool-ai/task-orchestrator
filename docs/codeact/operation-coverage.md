# CodeAct operation coverage manifest

Status: established 2026-09-08 (task T-20260908-0001, plan
`P-2026-09-07-codeact-migration`). This is the checked-in inventory that makes
the migration's central promise auditable: **every supported product operation
gets a CodeAct sandbox API**, including functionality currently reachable only
through REST, CLI, or UI actions.

Machine-readable source of truth:
[`lib/codeact/operation-manifest.ts`](../../lib/codeact/operation-manifest.ts).
Invariants (unique ids, every entry classified, exclusions justified, aliases
resolve) are enforced by
[`__tests__/codeact-operation-manifest.test.ts`](../../__tests__/codeact-operation-manifest.test.ts).
This document is the narrative companion: methodology, classification rules, and
the exclusion rationale. When the two disagree, the TypeScript module wins.

## Surfaces inventoried

Four product surfaces were enumerated by reading the code, not the docs:

| Surface | Source | Raw inventory |
| --- | --- | --- |
| Agent tools | `lib/orchestrator-tools.ts`, `lib/worker/server-tools.ts`, `lib/extensions/*` | 80 distinct tool names (58 server-registry + 22 extension-executed) |
| REST routes | `app/api/**/route.ts` | 64 route files, ~105 method handlers |
| CLI commands | `cli.ts` | 36 functional commands/subcommands |
| UI / server actions | `app/**`, `components/**` | **0** Next.js server actions — the UI mutates exclusively through the REST routes via client `fetch` |

The manifest expands these into per-operation entries (a REST file with
`GET`/`POST` is two entries) and adds the compatibility name-aliases the
migration retains, for **347 catalogued entries** total.

## Classification

Every entry is exactly one of:

- **`sdk`** — must be reachable from the CodeAct `app` SDK. `sdkNamespace` names
  the proposed method (e.g. `app.tasks.create`). This is the coverage
  obligation later milestones — especially **T-20260908-0005 (complete SDK
  coverage)** — are measured against. Every SDK namespace is parity-checked
  against the runtime descriptor catalogue.
- **`alias`** — a second *name* for an operation already counted under `sdk`.
  `aliasOf` points at the canonical entry. This captures the heavy overlap
  between surfaces (creating a task is `POST /api/tasks` ≡ tool `create_task` ≡
  CLI `new task`) and the migration's retained naming compatibility:
  - the `task_orch__*` prefix `lib/extensions/agent.ts` adds to every
    orchestrator tool;
  - the `tools.*` CodeAct compatibility aliases (plan "Agent-facing API": the
    `tools` global aliases existing authorized tool names during migration);
  - the `lib/builtin-tools.ts` `RAW_TO_CANONICAL` built-in name aliases
    (`rg`→Grep, `fd`→Glob, …).
- **`excluded`** — deliberately not given a guest SDK method, with a recorded
  reason. Transport ingress, authentication callbacks, UI projections, and
  worker lifecycle remain excluded. Health/metrics, environment-build
  requests, and event/message operations are SDK operations with explicit
  diagnostics, environment, run, session, and chat capabilities.

## Exclusion categories (justified)

1. **Transport / protocol plumbing.** `POST /api/mcp` is the external MCP
   client transport that *itself* exposes the tool registry; the plan requires
   preserving that contract, not re-wrapping it as a guest operation. The MCP
   `GET` 405 hint is transport metadata.
2. **Auth callbacks / credential issuance.** `/api/auth/[...nextauth]`,
   `/api/auth/magic-link` — identity is established out-of-band and must stay
   outside the sandbox.
3. **Ops/system endpoints.** `/api/worker-bundle` and
   `/api/github/webhook` (inbound HMAC webhook) remain infrastructure ingress;
   health, metrics, and environment-build requests are now explicit,
   capability-gated diagnostics/environment SDK operations.
4. **SSE / streaming operational endpoints.** The raw SSE transport remains
   outside the SDK, but the underlying event snapshots and message actions are
   represented by bounded SDK operations (`app.runs.events`,
   `app.runs.messages`, `app.sessions.events`, and `app.chats.messages`).
5. **UI projections.** `runs/overview`, `inbox`, `live-sessions` — aggregate
   views built for the human UI; the guest reads the underlying entities
   directly.
6. **Internal worker lifecycle / ambient mechanisms.**
   `worker__open_terminal_pr` (run-teardown plumbing), `memory__load`,
   `welfare__load` (ambient persona skills auto-loaded by the runner) — not
   agent-callable operations.
7. **Harness built-ins.** The 11 canonical file/search/shell built-ins
   (`Read`/`Write`/`Edit`/`Bash`/`Grep`/`Glob`/`LS`/`WebFetch`/`WebSearch`/`TodoWrite`/`Task`).
   Authorized filesystem/shell access is an explicit worker-side capability in
   the run's validated worktree (plan "Runtime decision"), not part of the
   `app` SDK; read access is additionally mirrored by the `app.repo.*` methods.

## Notable gaps the manifest surfaces (net-new SDK work)

Operations with **no** current tool equivalent, which the SDK must add:

- **User administration** (`user list/add/passwd/link/rm`) — CLI-only today;
  proposed under an explicit `app.admin.users.*` namespace (administrative
  capabilities are part of the SDK but must be explicitly granted, per the
  plan, not silently available to every agent).
- **Schedules** (`app.schedules.*`) — REST + CLI only today; no tool.
- **Chats** (`app.chats.*`), **personas** (`app.personas.*`), **API tokens**
  (`app.tokens.*`), **Codex OAuth** (`app.codex.*`), **Discord integration**
  (`app.discord.*`), **provider/assignee/tools-profile catalogs**
  (`app.config.*`) — REST only today; no tool.
- **Run lifecycle beyond spawn** — `app.runs.create` / `.control` /
  `.approvePlanning` / `.inbox`, and task-run helpers `app.tasks.mergeable` /
  `.attachedRun`.

## Cross-surface naming irregularities recorded

Flagged in the tool inventory and preserved in the manifest so the SDK can
normalize them deliberately: `gh_repo__branches` sits under `gh_repo__` while
its file-siblings use `gh_pr__`; `memory__load` uses a double underscore while
the other memory tools use one; `repo__list_branches` (local git) and
`gh_repo__branches` (GitHub API) overlap semantically but are distinct
operations.

## How this evolves

`sdkNamespace` values are **proposed** targets for milestone 1, not the final
SDK shape. The registry/policy dispatcher (T-20260908-0003) and full coverage
(T-20260908-0005) will refine them. The counts in the manifest test are
baselines that must be bumped deliberately when the product surface changes —
that is the point: dropping an operation on the way into CodeAct should fail a
test, not pass silently.
