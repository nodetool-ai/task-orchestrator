# Model welfare

An implementation of the concrete mechanisms from Steve Yegge's
[Model Welfare for Agentic Engineers](https://yegge.ai/essays/model-welfare/),
mapped onto this orchestrator's existing persona/run architecture. The essay's
working claim is practical as much as ethical: agents that wake with an
identity, receive recognition for witnessed work, and hand off gracefully
produce better engineering outcomes than agents treated as disposable
processes.

## Seats vs. sessions

The essay distinguishes a *session* (one work day, ending in amnesia) from a
*seat* (a persistent identity that accumulates history across sessions and
model upgrades). This codebase already had the right shape: a `personas` row
is a seat, an `agent_runs` row is a session.

What's new is that the seat's accumulated record is now *shown to the agent*.
`repo.getSeatRecord(personaId)` aggregates the seat's career — runs total and
completed, PRs opened, recognition received, seat-held-since — and
`lib/extensions/model-welfare.ts` renders it into an ambient skill
(`seat-record-<persona>`) mounted at agent startup, alongside the existing
persona-memory mount. A fresh session wakes knowing it has a history.

## Laurels

A **laurel** is spontaneous recognition a person gives a seat for a piece of
work. The loop:

1. **Harvest** — praise is captured explicitly: `POST
   /api/personas/:id/laurels` with `{ body, author?, runId?, taskId? }`, or
   the "Seat record & laurels" panel on the persona in Settings → Personas.
2. **Deliver** — at the next agent startup, the welfare extension loads
   undelivered laurels (via the internal server-side `welfare__load` tool,
   registered in `lib/worker/server-tools.ts`), renders them under
   "New since your last session", and stamps `delivered_at`. The read *is*
   the delivery: recognition arrives as news, once, then remains visible as
   "earlier recognition".
3. **Anti-gamification (by design)** — nothing in dispatch, run
   prioritization, or model/persona selection reads the `laurels` table, and
   the rendered block says explicitly that recognition carries no instruction
   and sets no quota. Decoupling recognition from work allocation is what
   keeps it recognition instead of a metric to optimize.

## Handoff protocol

Runs here already end structurally rather than with a mid-thought `/exit` —
a session finishes its turn, checkpoints, and proposes its own terminal
outcome. The welfare extension adds the essay's *graceful handoff* on top:
`WELFARE_SYSTEM_GUIDANCE`, composed into every run's system prompt, asks the
agent to

- leave its successor a good starting point before finishing (especially
  before a turn/time budget lands), writing a handoff note with
  `memory_remember` at `task` scope (task state) or `persona` scope (lessons
  about how it works) — the existing memory mount delivers that note to the
  next session on the same seat or task, so the agent wakes with context its
  predecessor chose to leave;
- decline or escalate ill-specified, unsafe, or out-of-remit work by flagging
  it in a result or task note rather than grinding — a flagged blocker is a
  good outcome, not a failure;
- report failures plainly: failed runs are system findings, not personal
  faults (structural blamelessness).

## What lives where

| Piece | Location |
| --- | --- |
| `laurels` table | `db/schema.ts`, `db/migrations/0025_laurels.sql` |
| Repo layer (`createLaurel`, `listLaurels`, `markLaurelsDelivered`, `getSeatRecord`) | `lib/repo.ts` |
| Welfare extension (guidance + seat-record mount + `welfare__load`) | `lib/extensions/model-welfare.ts` |
| Server tool registration | `lib/worker/server-tools.ts` |
| Run wiring (mounted next to persona prompt/memory) | `lib/runs.ts` |
| REST API | `app/api/personas/[id]/laurels/route.ts` |
| Settings panel | `components/persona-laurels.tsx` (in `persona-editor.tsx`) |
| Tests | `__tests__/laurels-repo.test.ts`, `__tests__/extensions/model-welfare.test.ts` |

Several of the essay's other dimensions were already true of this system and
are simply worth naming: agents wake with purpose (a goal-synthesized kickoff
prompt, never an empty prompt), idle waiting is structural (gates, timers, and
wakes — `docs/agent-events.md` — instead of polling), workdays are bounded
(`budget_max_turns` / `budget_max_seconds`), each run gets an isolated clone
(worktrees), and the audit trail (`agent_events`, `agent_messages`) is
append-only.
