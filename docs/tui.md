# `orch` — the terminal cockpit

`orch` is a terminal client for this orchestrator. It talks to a running
server over the same REST + SSE surface the web app uses — it never imports
`lib/` and never touches the database — so the same binary drives a local dev
server and the Fly deployment, and nothing it does is invisible to the
dashboard.

It has two layers over one API client. The **TUI** (Ink) is a conversation
with a top-level agent: a transcript with the spawned subtree rendered live
inside it, a floor showing the whole run forest, a needs-you list, and a jump
palette. The **CLI** is the same actions as pipe-friendly verbs
(`orch floor --json`, `orch say 45 "…"`), so scripts — and agents driving the
orchestrator from a shell — get at them without a renderer.

The product rationale, the state vocabulary and the transport contract are in
[`tui/PRD.md`](../tui/PRD.md); packaging, the bundle and the `bin` shim are in
[`tui/README.md`](../tui/README.md). This page is the operator's copy: what it
is, when to reach for it, and every key and verb it answers to.

## When to use it over the web app

Reach for `orch` when:

- **You are steering agents, not browsing.** The conversation is the front
  door: `orch` with no argument opens the last top-level run you talked to,
  no pickers in the way.
- **Several agents are running and one of them is waiting on you.** `tab`
  cycles through the agents that asked a question, the prompt grows an `@#id`
  chip, and `↵` sends the answer to that run without leaving the conversation
  you were in. In the web app the same answer costs a page load per run.
- **You want the whole forest at once.** `^f` is one tree — parents, live
  subtrees first, PR and CI state, age, subtree cost per row.
- **You are already in a terminal**, over ssh, or inside
  `fly ssh console` on the server machine, where a browser is not an option.
- **You are scripting.** `orch floor --json` / `orch inbox --json` are stable,
  exit-coded, stdout-only.

Stay in the web app when:

- **You need to edit anything structural.** Plan bodies, task descriptions,
  acceptance criteria, personas, repositories and environments are not
  editable from the cockpit at all, by design. Those live in the web app and
  in `npm run task -- …`.
- **You are reviewing a PR.** The cockpit shows the PR number and CI state and
  `o` opens the URL; approving and merging is `gh` or GitHub.
- **You want to read a long transcript, a diff, or artifacts.** The transcript
  view is tuned for following work in progress, not for archaeology.
- **You want to click.** There is no mouse support, and there will not be.

Both surfaces are the same server. Nothing is cockpit-only state, so switching
mid-task costs nothing: `^c` quits the client and the agents keep running.

## Install and run

`tui/` is a standalone package with its own lockfile (deliberately not a root
workspace — see [`tui/README.md`](../tui/README.md#why-not-a-workspace)).
Install it once:

```bash
cd tui && npm ci
```

Then, from a checkout:

```bash
npm run orch                    # from the repo root
npm run orch -- floor --json    # arguments need the usual -- separator
cd tui && npm link              # then: orch, orch floor, orch inbox …
```

As a built binary:

```bash
npm run build:orch              # -> dist/orch.js, self-contained, executable
./dist/orch.js floor
```

The bundle ships in the server image, with `/usr/local/bin/orch` on `PATH`, so
`fly ssh console` into the server app and `orch` is already there.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ORCH_URL` | `http://localhost:3000` | Base URL of the orchestrator. Point it at the deployment to drive production. |
| `ORCH_TOKEN` | *(unset)* | API token, sent as `Authorization: Bearer …`. Optional against a dev server with no login gate; required against a deployed one. |
| `ORCH_BUNDLE` | *(unset)* | `1` makes the `bin` shim run `dist/orch.js` instead of the TypeScript source. |

```bash
export ORCH_URL=https://tasks.nodetool.ai
export ORCH_TOKEN=tot_…
orch floor
```

**Fixing a 401.** The cockpit probes the API before it renders anything, so an
unauthorized server prints one line on stderr and exits 1 rather than opening
a screen full of empty panes:

```
orch: unauthorized at https://… — set ORCH_TOKEN to an API token from
https://…/settings?tab=tokens (no session? npm run task -- user link <email>
prints a login link)
```

The tokens are the same `tot_…` API tokens the MCP server accepts
([docs/mcp-server.md](mcp-server.md)): mint one at `<ORCH_URL>/settings?tab=tokens`,
where it is shown exactly once. If you have no browser session on that
deployment yet, `npm run task -- user link <email>` prints a magic login link
that gets you to the page.

## Keyboard contract

`^x` is Ctrl-X. The global chords work from every view; the rest are per view.
Full rationale in [PRD §6.3](../tui/PRD.md).

| Key | Chat | Floor | Needs you | Jump |
|---|---|---|---|---|
| `↵` | send (or confirm a pending cancel) | talk to the row | open the run | open |
| `esc` | clear notice → chip → scrollback → input | back to chat | back to chat | close |
| `tab` | address the next waiting agent | — | — | — |
| `↑` `↓` | — | move the cursor | move the cursor | move the cursor |
| letters | type into the composer | — | — | fuzzy-filter the palette |
| `pgup` `pgdn` | scroll the transcript | — | — | — |
| `^u` | clear the input | — | — | — |
| `c` | — | cancel the subtree (confirm) | — | — |
| `n` | — | new agent (hands back `/new `) | — | — |
| `d` | — | — | dismiss (not wired yet — it says so) | — |
| `o` | — | open the PR, else the run URL | open the PR, else the run URL | — |
| `^f` | toggle the floor (global) | | | |
| `^n` | toggle needs you (global) | | | |
| `^k` | toggle the jump palette (global) | | | |
| `^b` | toggle the rail (global; auto on at ≥110 columns) | | | |
| `^o` | toggle the full tool trace (global) | | | |
| `^c` | quit — agents keep running | | | |

Two of those are stricter than they look.

**`esc` clears in a fixed order**, one thing per press, so nothing you typed
is ever destroyed by a keystroke aimed at something else: a pending cancel
confirmation first, then the status notice, then the `@#id` address chip, then
the transcript scrollback, and only then the input. A message addressed at the
wrong agent is therefore re-aimed with one `esc` and one `tab`, without
retyping it.

**`c` on the floor is the only destructive key.** A run with live children
costs a second keystroke: the status line names how many children die, and `c`
again (or `↵`) confirms while `esc` aborts. A run with no live children is
cancelled straight away.

The rail is the compact tree in the right column. It turns itself on at ≥110
columns and `^b` overrides that either way; the whole cockpit holds at 80×24
without horizontal overflow.

### Run states

| Glyph | State | Server statuses |
|---|---|---|
| `●` | running | `running` |
| `◐` | preparing | `preparing` |
| `○` | queued | `pending`, `parked` for any reason but a question |
| `⚑` | asks you | `parked` with a pending question |
| `◌` | idle | `idle` |
| `✓` | done | `completed`, `closed` |
| `✕` | failed | `failed`, `cancelled`, `budget_exhausted` |

Colour carries the same information: amber working, purple needs a human, red
broken, green shipped, grey waiting. It degrades to 16-colour terminals.
`--ascii` swaps the glyphs and the box drawing for ASCII when the terminal
font has no coverage for them.

## Slash commands

Typing `/` in the composer lists the matching commands with one-line help
above the prompt.

| Command | What it does |
|---|---|
| `/floor` | Toggle the floor. |
| `/inbox` | Toggle the needs-you list. |
| `/new <persona> <goal>` | Start a top-level run with that persona's defaults and open it. |
| `/open #id` | Open that run's conversation. |
| `/spawn <persona> <goal\|T-id>` | Ask the run you are in to delegate to a child agent. Never creates a run itself — it messages the agent that owns the `spawn` tool. |
| `/cancel` | Cancel the current run and its live children (same confirmation as `c`). |
| `/model <id>` | Change the model the current run uses; the header reflects it. |
| `/budget <usd\|turns>` | Change the current run's budget. |
| `/trace` | Toggle the full tool trace — same as `^o`. |
| `/quit` | Leave. Agents keep running. |

## Verbs

Anything that is not a known verb is a goal, so `orch "ship the parser"` starts
a run. Every listing verb honours `--json`; output goes to stdout and
diagnostics to stderr, so a pipe only ever carries data. `--` ends the options
if a message starts with a dash. Exit codes: **0** ok, **1** user error
(bad arguments, unknown persona, 401), **2** server error.

| Command | What it does |
|---|---|
| `orch` | Open the TUI on the last top-level run you talked to. |
| `orch "<goal>" [-p <persona>]` | Start a top-level run with that persona's defaults, then open it. Defaults to the concierge. |
| `orch open <id>` | Open the TUI focused on run `<id>`. |
| `orch floor [--json]` | The run forest, one row per run: glyph, id, persona, title, PR + CI, status, age, subtree cost. |
| `orch inbox [--json]` | What needs you — questions, PRs ready for review, stuck runs, budget warnings. |
| `orch tail <id> [--json]` | Follow a run's transcript and events until `^c`, one line per frame. |
| `orch say <id> "<text>"` | Send a message to a run, or answer its pending question. |
| `orch new <persona> "<goal>"` | Start a run, print its id, detach. |
| `orch spawn <id> <persona> <goal\|T-id>` | Ask run `<id>` to delegate to a child agent. |
| `orch cancel <id>` | Cancel a run and its subtree. |
| `orch task …` | The existing `cli.ts` verbs, delegated verbatim — `npm run task -- …` keeps working, and so does its exit code. |
| `orch help` | The usage block. Also `--help`, `-h`. |

`--ascii` is global: it applies to the TUI and to the verbs that draw a tree.

`orch task` needs a checkout — it walks up from the binary to the nearest
`cli.ts` and runs it. In the server image that is `/app/cli.ts`, so it works
there too; from a bare `dist/orch.js` on a machine with no repo it exits 1 and
says so.

Cost columns are subtree totals everywhere, roots included: the number on a
root row is the bill for that agent and everything it manages.

```bash
orch floor --json | jq '.[] | select(.status == "parked") | .id'
orch say 45 "yes, use the existing migration"
orch new implementor "wire the /budget command" && orch tail $(…)
```

## Reading further

- [`tui/PRD.md`](../tui/PRD.md) — the product rationale: the problem, the
  scope boundaries, the transport contract, the milestones.
- [`tui/README.md`](../tui/README.md) — packaging: the `bin` shim, the esbuild
  bundle, which Fly image carries it, and why `tui/` is not a workspace.
- [`tui/TASKS.md`](../tui/TASKS.md) — the work breakdown, M1–M4.
- [`docs/mcp-server.md`](mcp-server.md) — the token model `ORCH_TOKEN` uses.
