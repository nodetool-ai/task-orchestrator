# Agent contract for Task Orchestrator

You (human or AI agent) are picking up work from this task system.
Read [SCHEMA.md](SCHEMA.md) first; this file describes the workflow.

## Two ways to do a task

1. **Yourself.** Claim it, code it, transition it. The flow below.
2. **Delegate to a Claude Agent SDK session.** Hit the "Run agent"
   button on the task page or `npm run task -- agent <T-...>`. The
   orchestrator opens a worktree, runs the agent, pushes the branch,
   opens a PR, and moves the task to `review`. Skip the rest of this
   doc unless you need to babysit a failed session.

## Picking up a task

1. `npm run task -- list --state=todo`
2. Pick a task whose dependencies are all `done`.
3. Claim it:
   ```bash
   npm run task -- transition T-20260511-0001 in_progress --assignee=<you>
   ```

## Doing the work

- Edit code as needed.
- Tick off acceptance criteria as you complete them (one click in the
  web UI), or:
  ```bash
  npm run task -- crit done <criterion-id>
  ```
- Add notes whenever you make a meaningful decision:
  ```bash
  npm run task -- note T-20260511-0001 --body="picked WAL mode for concurrent reads"
  ```
- Discover new work? Create a new task:
  ```bash
  npm run task -- new task --plan=P-... --title="..."
  ```

## Finishing

```bash
npm run task -- transition T-20260511-0001 review    # if reviewed by someone
npm run task -- transition T-20260511-0001 done      # gated by open criteria
```

`done` is rejected while any acceptance criterion is open —
finish those first.

## If you get stuck

```bash
npm run task -- transition T-20260511-0001 blocked \
  --note="Waiting on API spec from @alice"
```

Then pick a different task.

## Delegating to a Claude Agent session

Each session runs in an isolated git worktree on a fresh branch,
opens a PR via `gh pr create` when finished, and transitions the
task to `review` (or `blocked` on failure). Sessions run in
parallel against different tasks.

```bash
npm run task -- agent T-20260511-0001                 # start + tail
npm run task -- agent T-20260511-0001 --no-follow     # detach
npm run task -- agent T-20260511-0001 --model=claude-opus-4-7
npm run task -- agent T-20260511-0001 --backend=pi    # or claude; default from env
npm run task -- agent list                            # all runs
npm run task -- agent cancel <session-id>             # abort
```

REST: `POST /api/tasks/:id/sessions`. SSE log:
`GET /api/sessions/:id/events`. Web: "Run agent" button on the
task detail page → live log at `/sessions/:id`.

A task has one active session at a time — cancel or let it finish
before starting another. To pick up where a failed run left off,
use the Resume button (or `agent resume <id>`): the new session
passes the prior SDK session id to `query()` so the model keeps
its prior conversation in context.

Requires an authed `gh` CLI, plus agent-backend auth: the default `pi`
backend's own credentials, or — for `TASK_ORCH_AGENT_BACKEND=claude` —
`ANTHROPIC_API_KEY` when set, otherwise a claude.ai subscription via
`claude login` / `CLAUDE_CODE_OAUTH_TOKEN`.

While running, the agent can call back into the task system via the
orchestrator MCP tools — see [README.md](README.md) for the list. Use
them as you work; don't batch. Plans and tasks can carry image and
artifact attachments; the prompt lists them, and `get_attachment(id)`
returns an image as a viewable block or a text artifact decoded inline.

### Security note

The orchestrator runs the SDK with `permissionMode: "bypassPermissions"`
— the agent has full filesystem and shell access inside its worktree,
and that worktree shares the host's git config + `gh` credentials.
Triggering an agent is handing somebody a local shell in your repo.
Implications:

- Don't enable a publicly reachable `/api/tasks/:id/sessions` without
  the auth gate (DB-backed email/password, configured in `auth.ts`)
  protecting it.
- A malicious task body could direct the agent to do anything inside
  the worktree (and only the worktree — repo-level state is isolated).
- Agent sessions push branches and open PRs with your `gh` identity.

If you need a tighter sandbox, set permissions to an explicit allowlist
and curate the tool set instead — but `bypassPermissions` is the
intended default for the autonomous loop.

## Don'ts

- Don't bypass the state machine. The server enforces transitions; the
  CLI just relays calls.
- Don't delete notes. Notes are append-only by convention (no delete
  endpoint).
- Don't change `id`, `created_at`, or `plan_id`. If you need to re-home
  a task, cancel it and create a new one.
- Don't mark `done` without meeting the criteria.

## State cheat sheet

```
todo ──▶ in_progress ──▶ review ──▶ done
  │           │             │
  │           └─▶ blocked ──┘
  │           │
  └───────────┴─▶ cancelled
```

See [SCHEMA.md](SCHEMA.md) for the full transition table and field
requirements.
