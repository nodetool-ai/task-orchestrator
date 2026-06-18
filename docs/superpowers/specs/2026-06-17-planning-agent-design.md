# Planning Agent — Design

**Date:** 2026-06-17
**Status:** Draft — awaiting review
**Scope:** Single feature. Adds a guided, gated plan-creation flow ("the
planning agent") reachable from the Plans view. The agent interviews the
user, drafts a **spec**, gets it approved, saves it as a **plan**, drafts
an **implementation plan**, gets that approved, and materializes it as
**tasks**. Two hard review gates, enforced server-side.

## Motivation

Creating a good plan today is manual: the operator fills in
`new-plan-form` (title + freeform `body`), then either hand-writes tasks
or opens the free-form `plan-chat-box` and asks an agent to "break the
plan into tasks." That flow has no structure — the agent can rewrite the
body, invent tasks, and transition state in one shot with no checkpoint.

We want a **guided** path with explicit human approval between thinking
steps:

1. The user states a rough idea.
2. The agent asks clarifying questions until it understands the shape.
3. The agent drafts a spec; **the user reviews it**.
4. On approval, the agent saves the plan (spec → plan body) and drafts an
   implementation plan; **the user reviews it**.
5. On approval, the agent creates the tasks.

The win is that the operator reviews *thinking* (spec, task breakdown)
before any rows are written, and the gates are real — the agent cannot
skip ahead.

## Non-goals

- **No new spec/plan persistence model.** The spec is the plan's `body`
  (markdown). The implementation plan is the set of tasks. We do not add a
  `specs` table or a `spec` column. (See "Data model changes" — the only
  schema touch is one stage marker on `agent_runs`.)
- **No inline editing of the spec/plan inside the review card** for v1.
  Review is binary: **Approve** or **Request changes** (the latter sends
  feedback back into the chat and the agent revises). Direct hand-editing
  of the plan body / tasks remains available on the plan page afterward.
- **No bespoke wizard page / state machine UI.** We reuse the existing
  run/chat streaming surface (`/runs/[id]`) and render the gates as
  inline review cards, rather than building a separate multi-step page.
- **No multi-plan or plan-splitting** from one session. One planning
  session produces at most one plan.
- **No changes to the agent-backend seam, the run lifecycle, or the
  orchestrator tool set** beyond adding one extension + one persona.

## Background — current state

Relevant existing machinery (all reused, none modified):

- **Runs/chat.** `lib/runs.ts` is the single ingress to the agent
  runtime. A "chat" is an `agent_runs` row with `goal: "<chat>"` and
  `cwdStrategy: "none"`. `runs.append()` streams a turn over SSE;
  `runOneTurn()` resolves the tools profile per turn and calls the
  active backend's `runTurn()`. Messages persist to `agent_messages`.
- **Run-create API.** `POST /api/runs` (`createRunSchema`) already accepts
  `goal`, `toolsProfile`, `cwdStrategy`, `planId`, `repoId`, `personaId`,
  `model`, and `initialPrompt`. No new fields needed to *create* a
  planning run.
- **Orchestrator tools.** `lib/orchestrator-tools.ts` defines the shared
  tool set; `lib/extensions/agent.ts` registers them as
  `task_orch__*` (`create_plan`, `update_plan`, `create_task`,
  `transition_task`, …). They accept an `OrchestratorToolContext` with
  `defaultPlanId` so a plan-scoped run can omit `plan_id`.
- **Profiles.** `lib/profiles.ts` maps comma-separated profile names to
  extension factories: `orchestrator`, `repo_write`, `repo_read`,
  `gh_pr`, `gh_ci`, `spawn`.
- **Personas.** `lib/personas/*.ts` bind (system prompt, model,
  `toolsProfile`, budgets) to a named role; a `planner` persona already
  exists (`toolsProfile: "orchestrator,repo_read"`).
- **Interceptors.** The agent-backend seam supports
  `interceptToolCall(fn)`, mapped to a `PreToolUse` hook on both backends
  with `deny` / `updatedInput` outcomes (`lib/agent-backend/claude-backend.ts`).
  This is how we enforce the gates server-side.
- **Run view.** `components/runs/run-view.tsx` renders the streamed
  message log and the composer for `/runs/[id]`.

## The arc and where data lands

| Step | Actor | Action | Persisted effect |
|------|-------|--------|------------------|
| 1 | User | States the idea (sent as the run's first message) | `agent_runs` row created, `planning_stage = gathering` |
| 2 | Agent | Asks clarifying questions; iterates until confident | — |
| 3 | Agent | `propose_spec(title, spec_markdown, open_questions?)` | stage → `spec_review`; spec card rendered |
| 4 | User | **Approve** / **Request changes** | Approve → stage `building_plan` + "proceed" message; Changes → feedback message, stage unchanged |
| 5 | Agent | `commit_spec_as_plan()` then `propose_implementation_plan(tasks[])` | **plan row created** (`body` = spec, `state = draft`); `run.planId` set; stage → `plan_review`; plan card rendered |
| 6 | User | **Approve** / **Request changes** | Approve → stage `committing` + "proceed"; Changes → feedback message, stage unchanged (`plan_review`); agent re-proposes |
| 7 | Agent | `create_task` per item (orchestrator tool, `plan_id` defaults to `run.planId`) | **task rows created**; stage → `done`; summary + link to plan |

## Stage machine

A new `planning_stage` on the run drives both gate enforcement and which
UI affordance the run view shows.

```
gathering ──propose_spec──▶ spec_review ──user Approve──▶ building_plan
                            ▲ (Request changes:                  │
                            │  re-propose, stage held)           │ propose_implementation_plan
                            └─ stays spec_review                 ▼
                                              plan_review ◀───────┘
                                                │  ▲ (Request changes: re-propose, stays plan_review)
                                user Approve     │
                                                ▼
                                            committing ──tasks created──▶ done
```

On either gate, **Request changes** is just a user message — the stage is
held and the agent re-proposes (`propose_spec` is valid in `spec_review`,
`propose_implementation_plan` in `plan_review`). Only **Approve** advances
the stage.

- `gathering` — interview phase.
- `spec_review` — pending spec awaiting the user (gate 1).
- `building_plan` — spec approved; agent may create the plan + propose the
  task breakdown.
- `plan_review` — pending implementation plan awaiting the user (gate 2).
- `committing` — plan approved; agent may create tasks.
- `done` — tasks created. The run becomes an ordinary plan-scoped chat
  (orchestrator tools still available, gates dormant).

**Stage advances on Approve are a user action, not an agent action** —
that is the gate. The agent's tools merely check the current stage.

## Components to build

### 1. `planning_stage` column (`db/migrations/0014_planning_stage.sql`, `db/schema.ts`)

Add `planning_stage TEXT` to `agent_runs`, nullable. `NULL` = an ordinary
run (no planning behavior). Set to `gathering` when a planning run is
created. Add to `RunRow` / run serialization in `lib/runs.ts`. A small
`repo.setPlanningStage(runId, stage)` helper performs the transitions.

### 2. `planning-agent` persona (`lib/personas/planning-agent.ts`, registered in `index.ts`)

- `id: "planning-agent"`, name "Planning Agent".
- `toolsProfile: "orchestrator,repo_read,planning"` — reads the repo to
  ground the spec, uses orchestrator tools to write the plan/tasks, and
  the new `planning` profile for the gate tools. No `repo_write` (it never
  edits code).
- `model`: a strong reasoning model (default to the same provider/model
  the other planning-class personas use; configurable).
- System prompt encodes the arc explicitly: interview first (ask all
  material questions up front, in one batch where possible); call
  `propose_spec` and **stop**; after approval call `commit_spec_as_plan`
  then `propose_implementation_plan` and **stop**; after approval create
  the tasks with `create_task` (clear title, short body, 2–4 acceptance
  criteria each, dependencies where ordering matters). It is told the
  gates are enforced and that calling a write tool out of stage will be
  denied.

### 3. `planning` tools extension (`lib/extensions/planning.ts`, profile in `lib/profiles.ts`)

Registers the gate tools and one interceptor. Instantiated per turn with
the run context (`runId`, current stage, `planId`).

Tools:
- **`propose_spec({ title, spec_markdown, open_questions? })`** — valid in
  `gathering` or `spec_review` (revisions). Records the pending spec
  (latest `propose_spec` call in the message log is the source of truth —
  no extra storage), advances `gathering → spec_review`. Returns:
  "Spec shown to the user for review. Stop now; do not create the plan
  until they approve."
- **`commit_spec_as_plan({ title? })`** — valid only in `building_plan`.
  Calls `repo.createPlan({ title, body: <approved spec markdown>, state:
  "draft", repoIds })`, writes the new id to `run.planId`, returns the
  plan id. (Dedicated tool — not the generic `create_plan` — so capturing
  the new plan id into the run is trivial and unambiguous.)
- **`propose_implementation_plan({ tasks: [{ title, body, criteria[],
  dependencies?, estimate? }] })`** — valid in `building_plan` or
  `plan_review` (revisions). Records the pending breakdown, advances
  `building_plan → plan_review`. Returns: "Plan shown for review. Stop;
  do not create tasks until they approve."

Interceptor (`interceptToolCall`) — the hard gate. For a planning run it
**denies**:
- the generic `task_orch__create_plan` (the agent must use
  `commit_spec_as_plan`);
- `task_orch__create_task` / `update_task` / `transition_task` unless
  stage ∈ {`committing`, `done`};
- `commit_spec_as_plan` unless stage == `building_plan`;
- `propose_spec` outside {`gathering`, `spec_review`};
- `propose_implementation_plan` outside {`building_plan`, `plan_review`}.

Deny messages are instructive ("Spec not yet approved — wait for the user
to approve before creating the plan") so the agent self-corrects.

### 4. Approve endpoint (`app/api/runs/[id]/planning/route.ts`)

`POST /api/runs/[id]/planning` `{ action: "approve_spec" | "approve_plan" }`.
- `approve_spec`: requires stage `spec_review` → sets `building_plan`,
  then posts a canned user message ("Approved the spec — create the plan
  and draft the implementation plan.") via the normal append path to wake
  the agent.
- `approve_plan`: requires stage `plan_review` → sets `committing`, posts
  "Approved the implementation plan — create the tasks."

"Request changes" needs no endpoint: it is an ordinary user message typed
into the composer; the agent revises and re-proposes (allowed by the
stage rules above).

### 5. Entry point (`app/plans/page.tsx` + small client component)

A **"Plan with agent"** button on the Plans index, beside the existing
manual New Plan form. Optional repo picker (defaults to the default repo).
On submit it `POST /api/runs` with `goal: "<plan>"`, `personaId:
"planning-agent"`, `toolsProfile` from the persona, `cwdStrategy: "repo"`
(or `none` if no repo), `repoId`, and `initialPrompt` = the user's idea,
then navigates to `/runs/[id]`. The run starts in stage `gathering`
(set by `runs.create` when `goal === "<plan>"`).

### 6. Review cards in the run view (`components/runs/run-view.tsx` + `components/runs/planning-review-card.tsx`)

When `run.planningStage` is `spec_review` (resp. `plan_review`), find the
latest `propose_spec` (resp. `propose_implementation_plan`) tool call in
the message stream and render a **review card** in place of the normal
"awaiting input" affordance:
- **Spec card** — renders `spec_markdown` (via existing `markdown-body`)
  and any `open_questions`; buttons **Approve** (→ approve endpoint) and
  **Request changes** (focuses the composer with a hint).
- **Plan card** — renders the proposed tasks (title, body preview,
  criteria count, dependencies); same two buttons.

In all other stages the run view behaves like a normal chat. After
`done`, the card is replaced by a "Created plan P-… with N tasks" summary
linking to `/plans/[planId]`.

## Data flow (happy path)

```
Plans page ──POST /api/runs {goal:"<plan>", persona, initialPrompt}──▶ run (stage gathering)
   └─navigate ▶ /runs/[id]
Agent turn: asks questions ──▶ user answers (composer) ──▶ agent propose_spec ──▶ stage spec_review
   └─ run view renders Spec card
User Approve ──POST /api/runs/[id]/planning {approve_spec}──▶ stage building_plan + "proceed" msg
Agent turn: commit_spec_as_plan ──▶ plan row (body=spec), run.planId set
            propose_implementation_plan ──▶ stage plan_review
   └─ run view renders Plan card
User Approve ──POST .../planning {approve_plan}──▶ stage committing + "proceed" msg
Agent turn: create_task × N (plan_id defaults to run.planId) ──▶ stage done
   └─ run view renders summary + link to /plans/[planId]
```

## Error handling

- **Agent calls a write tool out of stage** → interceptor denies with an
  instructive message; the turn continues and the agent re-proposes or
  waits. No partial writes.
- **Approve clicked in the wrong stage** (double-click / stale UI) → the
  endpoint validates the current stage and returns 409; the card refreshes
  from `run.planningStage`.
- **`commit_spec_as_plan` fails** (e.g. repo validation) → tool returns the
  error; stage stays `building_plan`; the agent surfaces it and can retry.
- **User abandons mid-session** → the run simply rests at its stage; it can
  be resumed later (it is an ordinary run). No orphaned plan unless the
  spec was already approved (then a `draft` plan exists with no tasks,
  which is fine and visible on the Plans page).
- **Tasks fail partway** in `committing` → already-created tasks persist;
  the agent reports which succeeded; re-running creates the rest (the
  agent lists existing tasks first). Stage stays `committing` until it
  reports completion (→ `done`).

## Testing

- **Repo layer (Vitest, in-memory SQLite):** `setPlanningStage`
  transitions; `commit_spec_as_plan` creates a `draft` plan with body =
  spec and sets `run.planId`; planning stage is included in `RunRow`.
- **Gate enforcement (unit):** the `planning` interceptor denies
  `create_task` in `spec_review`/`building_plan`, denies generic
  `create_plan` in any planning stage, denies `commit_spec_as_plan`
  outside `building_plan`, and allows each tool in its valid stage.
- **Approve endpoint:** advances stage and appends the proceed message
  only from the correct prior stage; returns 409 otherwise.
- **API/route smoke:** creating a `<plan>` run seeds stage `gathering`.

## Open questions

1. **Spec also stored as a plan attachment?** Default: no — the plan
   `body` is the spec, full stop. Revisit only if we later want to keep
   the spec separate from a leaner plan body.
2. **Plan starting state.** Default: `draft`. The operator bumps it to
   `proposed`/`accepted` manually after tasks land. (Could auto-set
   `proposed` on `done`; left manual for now.)
3. **Reuse `planner` vs. new `planning-agent` persona.** This spec adds a
   new persona so the staged system prompt and the `planning` profile stay
   isolated from the existing free-form `planner`. Cheap to merge later if
   desired.
