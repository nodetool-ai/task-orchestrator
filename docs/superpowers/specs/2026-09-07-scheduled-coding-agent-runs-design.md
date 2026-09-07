# Scheduled coding-agent runs

**Status:** proposed

## Goal

Add durable, orchestrator-native schedules for coding-agent work. A due occurrence creates a standalone task, launches a normal persistent-Sprite implementation run, and uses the existing branch, push, PR, review, and CI feedback lifecycle.

GitHub Actions is not part of scheduling or execution.

## Product decisions

- Support one-time, fixed-interval, and five-field cron schedules.
- Store an IANA timezone per schedule; UTC is the default.
- After downtime, launch only the latest missed occurrence.
- Skip an occurrence while the same schedule still has an active run.
- Each occurrence creates a new standalone task and agent run.
- A schedule is pinned to one registered repository and defaults to its default branch.
- A run that makes commits opens a ready-for-review PR; no-change runs succeed without one.
- Auto-merge is configurable per schedule, off by default, and uses squash auto-merge after required checks pass.
- Model, persona, permissions, and turn/USD/seconds budgets are configurable per schedule. Omitted values inherit persona/deployment defaults.
- Existing review and CI-autofix follow-ups continue on the same run and Sprite.
- Deleting a schedule is a soft delete; generated tasks, runs, PRs, and occurrence history remain.
- Tasks may be standalone globally. A non-null plan behaves exactly as before; null means deliberately standalone.

## Data model

### `run_schedules`

- `id` serial primary key
- `name`, `prompt`
- `repo_id` required FK, `base_branch` nullable
- `kind`: `once | interval | cron`
- `run_at`, `interval_seconds`, `cron_expression`, selected according to kind
- `timezone` default `UTC`
- `enabled`, `next_run_at`, `last_scheduled_at`
- launch overrides: `persona_id`, `model`, `tools_profile`, `auto_merge`
- budgets: `budget_max_turns`, `budget_max_usd`, `budget_max_seconds`
- `user_id`, `created_at`, `updated_at`, `deleted_at`

Kind-specific checks reject ambiguous trigger configurations. Intervals advance from scheduled time rather than completion time. Cron evaluation uses the stored timezone and a maintained parser library rather than a home-grown calendar implementation.

### `schedule_occurrences`

- `id` serial primary key
- `schedule_id` FK
- `scheduled_for`
- `status`: `pending | launching | launched | skipped | failed`
- `error`, `created_at`, `updated_at`
- unique `(schedule_id, scheduled_for)`

`tasks.schedule_occurrence_id` and `agent_runs.schedule_occurrence_id` are nullable unique foreign keys. These idempotency links let recovery find work created before a crash without creating a second task or run.

### Existing tables

- Drop `NOT NULL` from `tasks.plan_id`, retaining the existing FK and `ON DELETE CASCADE` behavior for planned tasks.
- Add `agent_runs.auto_merge`, default true, to preserve current manual-run behavior. Scheduled runs pass their configured value, default false.

## Scheduler lifecycle

The existing control-plane pending pump calls `fireDueSchedules`; no worker process accesses the scheduling tables.

1. Claim due schedules in a short PostgreSQL transaction with row locking.
2. Insert or recover the unique occurrence and advance `next_run_at` or disable a completed one-time schedule in the same transaction.
3. Outside the claim transaction, skip if the schedule has another nonterminal occurrence run.
4. Create or recover a standalone task linked by `schedule_occurrence_id`.
5. Launch or recover a normal implementation run through the canonical `agent.startSession` / `runs.create` path.
6. Mark the occurrence launched and emit a `scheduled_run` agent event.
7. On restart, pending/launching occurrences are reconciled through their task/run idempotency links. Failures are isolated per occurrence and retained for operators.

`Run now` inserts an occurrence for the current instant through the same path. Pause prevents future claims. Resume recomputes the next future occurrence. Soft delete pauses permanently.

## Standalone-task compatibility

- `CreateTaskInput.planId` and `TaskFull.planId` become nullable.
- Omitted/null plan creation is standalone; unknown non-null plan IDs remain errors.
- Standalone tasks may select any registered repository. Planned tasks retain plan-repository membership checks.
- Plan progress and plan deletion ignore standalone tasks.
- Global task lists include standalone tasks; plan-filtered views do not.
- Agent prompts label standalone tasks and omit parent-plan/sibling context.
- Web, CLI, MCP, TUI, and mobile contracts expose `planId: string | null` without casts.

## API and CLI

REST:

- `GET/POST /api/schedules`
- `GET/PATCH/DELETE /api/schedules/:id`
- `POST /api/schedules/:id/run`
- collection responses include recent occurrence/run/PR state

CLI:

- `schedule list`, `schedule show`
- `schedule create`
- `schedule update`
- `schedule pause`, `schedule resume`, `schedule run`, `schedule delete`

The API and CLI call shared validation/repository services. Every mutation is authenticated and records the owning user when available.

## Web UI

Add `/schedules` to the desktop and mobile navigation using the existing clock glyph.

The page has:

- a dense semantic table of status, name, cadence, repository, next occurrence, last run, and PR;
- Run now, Pause/Resume, Edit, and Delete controls with schedule-specific accessible names;
- an inline create/edit form;
- recurrence fields revealed by trigger kind with a timezone-aware next-run preview;
- progressive run configuration for persona, model, permissions, auto-merge, and budgets;
- explicit loading, validation, empty, and destructive-confirmation states.

Use existing UI primitives and pickers. Keep status glyphs and graphite surfaces as the only visual vocabulary.

## Validation contract

Automated checks:

- one-time schedules fire once;
- intervals and cron calculate the correct future instant, including timezone/DST cases;
- latest-only downtime catch-up;
- overlap skipping;
- two concurrent sweepers cannot duplicate an occurrence;
- crash recovery cannot duplicate tasks or runs;
- pause/resume/run-now/soft-delete behavior;
- configuration inheritance and override propagation;
- scheduled auto-merge off by default and manual-run compatibility preserved;
- standalone-task create/update/filter/prompt/plan-progress behavior;
- authenticated REST CRUD/action coverage;
- CLI parsing and output coverage;
- typecheck across web, TUI, and mobile contracts.

Commands:

- focused Vitest suites for schedules and standalone tasks
- `npm run typecheck`
- `npm test`
- `cd tui && npm run typecheck && npm test`

User-flow validation:

- create one schedule of each kind;
- inspect next-run preview;
- edit run configuration;
- invoke Run now and observe occurrence/task/run linkage;
- pause/resume and delete through keyboard-accessible controls;
- inspect desktop and narrow-screen layouts without console errors.

## Non-goals

- GitHub Actions self-hosted runners
- automatic merge without required checks
- running every missed occurrence after downtime
- overlapping runs for one schedule
- hard-deleting generated history
- general-purpose non-agent workflow scheduling
