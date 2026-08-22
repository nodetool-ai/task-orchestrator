# PRD — Task Orchestrator terminal cockpit (`orch`)

Status: draft 1, 2026-08-22. Companion: [DESIGN.md](DESIGN.md) (concept and
views), [TASKS.md](TASKS.md) (work breakdown). Mockup: `npm run mock` in this
directory.

## 1. Problem

The web app is a dashboard with a chat bolted on. An operator who steers
agents spends most of the time in a conversation with one or two top-level
agents (concierge, planner, executor), and the rest of the time answering
what those agents ask. Today that conversation sits one click deep on
`/runs`, behind four pickers, and "what waits on me" is split across the
floor, the run page inbox toggle, and the sidebar footer.

Operators already live in a terminal next to the app. A terminal cockpit
removes the context switch and makes the conversation the primary surface.

## 2. Goal

One binary, `orch`, with two layers:

- **TUI** (Ink): a conversation with a top-level agent, plus a floor (the
  run forest), a needs-you list, and a jump palette. Claude Code rhythm.
- **CLI**: the same actions as pipe-friendly verbs with `--json`, for scripts
  and for agents that drive the orchestrator from a shell.

Success is measured by operator throughput: how many agents one person
supervises in parallel, how fast they see a stuck or asking agent, and how
few keystrokes an answer costs.

## 3. Users

The PRODUCT.md audience: the maintainer and a few collaborators fluent in
terminals. No onboarding for strangers. Keyboard first. Dense.

## 4. Scope

### In scope (v1)

1. **Chat view.** Transcript of the current run: `>` you, agent prose, dim
   `⎿` tool lines, `·` events, `⚑` questions. Composer at the bottom with
   slash commands and inline help.
2. **Live child tree in the transcript.** A `spawn` frame renders the
   spawned subtree as rows that update with status, age, cost, PR.
3. **Answer in place.** `tab` cycles through agents that wait on a human;
   the prompt grows an `@#id` chip; `↵` sends the answer to that run and the
   run resumes. The operator stays in the current conversation.
4. **Floor.** The whole run forest as one tree, live subtrees first.
   `↵` talk, `c` cancel subtree, `n` new top-level agent.
5. **Needs you.** Questions, PRs ready for review, stuck runs, budget
   warnings. `↵` answers or opens. `d` dismisses.
6. **Jump.** `^k` fuzzy palette over runs, tasks, plans.
7. **Rail.** Optional right column with the compact live tree. Auto on at
   ≥110 columns, `^b` toggles.
8. **New agent.** `/new <persona> <goal>` and `orch "<goal>"` start a
   top-level run with the persona's defaults (engine, model, reasoning,
   repo). No pickers before the first message; `/model` and `/budget`
   change them later.
9. **CLI verbs**: `floor`, `inbox`, `say`, `tail`, `new`, `spawn`,
   `cancel`, `open`, plus the existing `task` verbs from `cli.ts` unchanged.
10. **Remote.** The TUI talks to the server over REST + SSE with an API
    token (`ORCH_URL`, `ORCH_TOKEN`), so it works against the Fly
    deployment. It does not import `lib/` directly.

### Out of scope (v1)

- Editing plan bodies, task descriptions, criteria text, personas, repos.
  These stay in the web app and in `npm run task -- …`.
- PR review actions (approve, merge). `gh` and the web do that. The TUI
  shows the PR number and CI state and opens the URL on `o`.
- Light theme. The terminal's own palette applies; only the six state hues
  are fixed.
- Mouse support.

## 5. Decisions taken (the open questions from DESIGN.md)

1. **Front door.** `orch` with no argument opens the most recent top-level
   run the operator talked to. `orch "<goal>"` always starts a new concierge
   run. The concierge stays the default persona.
2. **PR actions.** Out of scope for v1 (see above). The needs-you row shows
   the PR and `o` opens it in the browser.
3. **Trace density.** Tool lines collapse to one line each. `^o` toggles the
   full tool trace for the current run, like Claude Code.
4. **Cost columns.** Every tree row shows its subtree total. Roots show the
   same figure, so the root number is the bill for that agent and all it
   manages.

## 6. Functional requirements

### 6.1 Transport

- `GET /api/runs/overview` and `GET /api/runs/overview/events` (SSE) feed the
  floor, the rail, and the needs-you counts.
- `GET /api/runs/:id`, `GET /api/runs/:id/events?msgCursor&evtCursor` (SSE)
  feed the transcript. Reconnect with the last cursor on drop.
- `POST /api/runs/:id/messages` sends a message or an answer.
- `GET /api/runs/:id/inbox` feeds the needs-you list; aggregate across live
  runs for the global list (or add `GET /api/inbox` server-side, see TASKS).
- `POST /api/runs` starts a top-level run; `PATCH /api/runs/:id` cancels.
- Auth: `Authorization: Bearer <token>` from `ORCH_TOKEN` (lib/api-tokens).
  Local dev without a token works because the dev server has no login gate.

### 6.2 State vocabulary

Map server `SessionStatus` to the seven TUI glyphs: `●` running, `◐`
preparing, `○` queued, `⚑` parked with `pendingQuestion`, `◌` idle (chat not
working), `✓` completed, `✕` failed / cancelled / budget_exhausted. Colours:
amber working, purple needs a human, red broken, green shipped, grey waiting.

### 6.3 Keyboard contract

| Key | Chat | Floor | Needs you | Jump |
|---|---|---|---|---|
| `↵` | send | talk to row | answer / open | open |
| `esc` | clear chip, then clear input | back | back | close |
| `tab` | address next waiting agent | — | — | — |
| `^f` `^n` `^k` `^b` | toggle floor / needs you / jump / rail (global) | | | |
| `^o` | toggle full tool trace | — | — | — |
| `^c` | quit; agents keep running | | | |
| `c` | — | cancel subtree (confirm) | — | — |
| `n` | — | new agent | — | — |
| `d` | — | — | dismiss | — |
| `o` | — | open PR / run URL | open PR / run URL | — |

### 6.4 Slash commands

`/floor` `/inbox` `/new <persona> <goal>` `/open #id` `/spawn <persona>
<goal|T-id>` `/cancel` `/model <id>` `/budget <usd|turns>` `/trace` `/quit`.
Typing `/` shows matching commands with one-line help above the prompt.

### 6.5 CLI verbs

```
orch                          open last top-level run (TUI)
orch "<goal>" [-p persona]    new top-level run (TUI)
orch open <id>                TUI focused on run
orch floor [--json]           the tree, one row per run
orch inbox [--json]           what needs you
orch say <id> "<text>"        message / answer a run
orch tail <id> [--json]       follow transcript + events
orch new <persona> "<goal>"   start, print id, detach
orch spawn <id> <persona> <goal|T-id>
orch cancel <id>
orch task …                   existing cli.ts verbs
```

All list verbs honour `--json`. Exit codes: 0 ok, 1 user error, 2 server
error. Output to stdout only; diagnostics to stderr.

## 7. Non-functional

- First paint under 300 ms against a local server; under 1 s over the Fly
  deployment. Render cached overview first, then hydrate.
- Idle CPU near zero: SSE, no polling, except a 30 s heartbeat on the
  overview stream.
- Works at 80×24. Rail hides below 110 columns. No horizontal overflow.
- No data loss on `^c`: the TUI is a client; all state lives on the server.
- Colours degrade to 16-colour terminals (chalk level 1).

## 8. Packaging

- `tui/` is an npm workspace package `@task-orchestrator/tui`, ESM, Node 22.
- Binary `orch` via `bin` in its `package.json`; `npm run orch` from the
  repo root. `cli.ts` verbs are exposed as `orch task …` by delegating to the
  existing module, so the old `npm run task -- …` keeps working.
- Bundled with esbuild to `dist/orch.js` for the Fly image, same pattern as
  `build:worker`.

## 9. Milestones

1. **M1 Read-only cockpit.** Floor, rail, chat transcript (live SSE), jump.
   No sending. Ship when an operator can watch a real plan execute.
2. **M2 Talk.** Send, answer with `tab`, `/new`, `/open`, `/cancel`.
3. **M3 CLI verbs + packaging.** `orch floor|inbox|say|tail|new|spawn|cancel`,
   `--json`, token auth, esbuild bundle, `orch task` delegation.
4. **M4 Polish.** `^o` trace, `/model` `/budget`, `o` open URLs, 80×24
   pass, reduced-colour pass, docs.

## 10. Risks

- **Inbox aggregation.** `GET /api/runs/:id/inbox` is per run. The needs-you
  list wants one call. Add `GET /api/inbox?audience=owner` (TASKS: T-tui-04).
- **Overview payload size.** The forest with transcripts is large; the
  overview endpoint must stay summary-only and the TUI must fetch transcripts
  per run on demand.
- **Terminal variance.** Box-drawing glyphs and `⚑` need a font with those
  code points. Provide an ASCII fallback flag `--ascii`.
