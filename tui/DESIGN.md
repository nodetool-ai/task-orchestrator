# Task Orchestrator CLI / TUI — design exploration

> **Historical.** This is the design record from before the cockpit was
> built — the concept, the view sketches and the open questions it left. It is
> kept for the reasoning, not as a description of what shipped, and it is not
> updated. The current documents are [PRD.md](PRD.md) (the spec, including the
> decisions that closed the open questions below) and
> [docs/tui.md](../docs/tui.md) (the operator's guide: install, keys, verbs).

Status: mockup with fake data. Run it: `cd tui && npm install && npm run mock`.
Quit with `ctrl+c` or `/quit`. Resize the terminal; the right rail hides
below ~110 columns (`ctrl+b` toggles it).

## Thesis

The web app is a dashboard with a chat bolted on. The terminal version is a
**conversation with an orchestrator** with a dashboard bolted on. The human
talks to a few top-level agents (concierge, planner, executor). Those agents
spawn and manage workers. The UI therefore has exactly three jobs:

1. Talk to the current top-level agent (Claude Code rhythm: `>` you, prose
   agent, dim `⎿` tool lines, inline live tree for spawned children).
2. Show what waits on a human (questions, PRs to review, stuck runs) and make
   answering a one-keystroke reach: `tab` addresses the asking agent, type,
   enter. You never leave the conversation.
3. Show the whole forest when you want the overview (`ctrl+f` floor) and jump
   anywhere (`ctrl+k`).

Everything else — plans, tasks, criteria, personas, repos — stays where it
already is: `npm run task -- …` for scripting, the web app for editing prose.

## Two layers, one binary

```
orch                       # TUI: opens the most recent top-level agent
orch "ship the CLI plan"   # TUI: new concierge run with this goal
orch -p concierge "…"      # pick the persona
orch open 45               # TUI, focused on run 45

# non-interactive, pipe-friendly, all take --json
orch floor                 # the tree, one line per run
orch inbox                 # what needs you
orch say 45 "use pi"       # message / answer a run
orch tail 44               # follow a run's transcript (events + text)
orch new planner "…"       # start a top-level agent, print its id, detach
orch spawn 43 implementor T-0006   # ask an orchestrator to delegate
orch cancel 43             # stop a subtree
orch task …                # the existing cli.ts verbs, unchanged
```

The TUI is a thin client over the same REST + SSE surface the web app uses
(`/api/runs`, `/api/runs/:id/messages`, `/api/runs/:id/events`,
`/api/runs/overview/events`, `/api/runs/:id/inbox`). It never imports
`lib/` directly, so it works against the Fly deployment with an API token.

## Views

| View | Enter | Leave | What it is |
|---|---|---|---|
| Chat | default, `↵` on any row elsewhere | — | Transcript with the current run + composer |
| Floor | `ctrl+f`, `/floor` | `esc` | Whole run forest as a tree; `↵` talk, `c` cancel, `n` new |
| Needs you | `ctrl+n`, `/inbox` | `esc` | Questions, reviews, stuck, budget; `↵` answers or opens |
| Jump | `ctrl+k` | `esc` | Fuzzy over runs, tasks, plans |
| Rail | `ctrl+b` | `ctrl+b` | Compact live tree at the right, `▸` marks where you are |

The composer is always visible under Floor and Needs-you too, so a slash
command is never more than one line away.

## Addressing

- `tab` cycles through agents that are waiting on you; the prompt grows a
  purple `@#45` chip and the answer goes there, not to the current run.
- `/open #45` switches the conversation to a worker when you want to see its
  tool trace. Its parent is shown as a breadcrumb in the header.
- A spawned child renders as a live row inside the parent's transcript; the
  row updates as the child's status changes, so you rarely need to open it.

## Status vocabulary (same six hues as the web)

`●` running · `◐` preparing · `○` queued · `⚑` asks you (parked) ·
`◌` idle · `✓` done · `✕` failed/cancelled. Amber = working, purple = needs a
human, red = broken, green = shipped, grey = waiting.

## Open questions for Matthias

1. Does the concierge stay the single front door, or do you want `orch` to
   open the *last* agent you talked to? (Mockup: last agent.)
2. Should `tab`-answer also cover PR review ("merge / request changes") or is
   that strictly a `gh` / web action?
3. Transcript density: tool lines collapsed to one line each (current), or a
   Claude Code-style `ctrl+o` to expand the full trace?
4. Is a per-run cost in every tree row worth the columns, or only a subtree
   total at the roots?
