# `orch` — Task Orchestrator terminal cockpit

A conversation with your top-level agents, plus the run forest, a needs-you
list and a jump palette — in the terminal. Ink + React, ESM, Node 22+.

Operator guide: [docs/tui.md](../docs/tui.md) (what it is, when to use it over
the web app, keys and verbs) · spec: [PRD.md](PRD.md) · work breakdown:
[TASKS.md](TASKS.md) · concept, historical: [DESIGN.md](DESIGN.md).

This file is the *packaging* half: install, the `bin` shim, the bundle, and
how it ships in the Fly image.

`orch` is a *client*. It talks to a running orchestrator over REST + SSE and
never imports `lib/` or touches the database, so the same binary drives a local
dev server and the Fly deployment.

---

## Install

`tui/` is a **standalone package with its own lockfile** — deliberately not a
root npm workspace (see [Why not a workspace](#why-not-a-workspace)). Install
it once:

```bash
cd tui && npm ci
```

Then run it from wherever you like:

```bash
npm run orch                    # from the repo root
cd tui && npm run orch          # from the package
./tui/bin/orch.mjs              # the bin target directly
```

Arguments after `npm run orch` need the usual `--` separator:

```bash
npm run orch -- floor --json
```

To get `orch` on your `PATH`:

```bash
cd tui && npm link              # then: orch, orch floor, orch inbox …
```

### The `bin` target

`bin.orch` is `tui/bin/orch.mjs`, a shim that picks an entry point:

1. **`tui/src/orch.tsx` through `tsx`** whenever the source and `tsx` are both
   present — i.e. in a git checkout. You always run the code you are editing;
   a stale bundle can never shadow it.
2. **`dist/orch.js`** (the esbuild bundle) otherwise — no TypeScript, no
   `tsx`, no `tui/node_modules` required.

Set `ORCH_BUNDLE=1` to force (2) — faster start, and how you smoke-test a
build. The shim exits 2 with an explanation when neither exists.

`tsx` stays a **devDependency** on purpose: nothing that ships depends on it.
Images run the bundle directly (`dist/orch.js` carries its own
`#!/usr/bin/env node` and is `chmod +x`), so the shim is a checkout
convenience, not a runtime requirement.

## Build

```bash
npm run build:orch              # from the repo root, or from tui/
# -> dist/orch.js (repo root), ~1.8 MB, executable
```

`tui/scripts/build-orch.mjs` runs esbuild:

```
entry     tui/src/orch.tsx
bundle    true, platform=node, format=esm, target=node22, jsx=automatic
loader    .tsx -> tsx, .ts -> ts
banner    #!/usr/bin/env node  +  createRequire shim for bundled CJS
plugin    stub for react-devtools-core (ink's optional DEV-only import)
outfile   <repo>/dist/orch.js   (chmod 755)
```

**Everything is bundled** — no `--packages=external`, unlike the root
`build:worker`. `ink`, `react` and their transitive deps live in
`tui/node_modules`, which no runtime image installs (images run `npm ci`
against the *root* `package.json`, and `ink` is not a root dependency). An
externals bundle would force either hoisting `ink` into the Next app's
dependency list or copying `tui/node_modules` into the runtime stage. A
self-contained file is cheaper and travels — same reasoning as
`scripts/build-worker-standalone.mjs`.

`react-devtools-core` is the single stubbed module. `ink`'s reconciler reaches
it through a `DEV`-gated dynamic import that esbuild follows into the graph;
marking it `external` makes esbuild hoist it to a *static* top-level import and
the bundle dies with `ERR_MODULE_NOT_FOUND` before `main` runs. The stub keeps
the graph closed and costs nothing (the branch only fires under `DEV=true`).

### In the Fly image

The bundle ships in the **server image** (`Dockerfile.server`, the image
`fly.toml` builds and `flyctl deploy --config fly.toml` releases):

- it is the long-lived control plane you `fly ssh console` into, and the only
  Fly app with a shell an operator actually visits;
- `orch` is a client of that server's REST + SSE API, so it belongs next to it;
- its runtime stage already does `COPY --from=build /app/dist ./dist`, so the
  bundle rides along for free. The build stage adds `npm --prefix tui ci &&
  npm run build:orch`; `tui/node_modules` never leaves that stage.
- a `/usr/local/bin/orch` symlink puts it on `PATH`. `orch task …` works there
  too: the bundle walks up from its own location to the nearest `cli.ts`, which
  in that image is `/app/cli.ts`, next to the `tsx` the root `npm ci` installed.

Not the worker (`Dockerfile.worker`) or runner (`Dockerfile.fly-runner`)
images: those are per-run, short-lived containers that talk to the control
plane over the worker WebSocket channel and hold no operator session — and the
runner image is already pressed against Fly's 8 GB unpacked-image limit.

`deploy.sh` (docker compose) needs no change: it builds `server` from the same
`Dockerfile.server`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `ORCH_URL` | `http://localhost:3000` | Base URL of the orchestrator. Point it at the Fly deployment to drive production. |
| `ORCH_TOKEN` | *(unset)* | API token, sent as `Authorization: Bearer …`. Optional against a dev server with no login gate; required against a deployed one. Mint one at `<ORCH_URL>/tokens`, or `npm run task -- user link …`. |
| `ORCH_BUNDLE` | *(unset)* | `1` makes the `bin` shim run `dist/orch.js` instead of the TypeScript source. |
| `ORCH_ASCII` | *(unset)* | Anything but `0`/`false`/`no` swaps every glyph and the box drawing for ASCII. Same as `--ascii`. |
| `ORCH_NO_ANIM` | *(unset)* | Any value stops the live line breathing and the unfinished tool dot blinking. Motion is off anyway under `--ascii` and when stdout is not a terminal. |
| `ORCH_COLORS` | *(detected)* | `16` forces the named ANSI palette, `truecolor` forces the 24-bit one. See [Terminal size and colour](#terminal-size-and-colour). |

A 401 prints one line on stderr naming the fix and exits 1 — it never opens an
empty cockpit.

```bash
export ORCH_URL=https://tasks.nodetool.ai
export ORCH_TOKEN=…
orch floor
```

## The transcript

The chat reads like Claude Code, because the operator is already reading Claude
Code all day:

```
❯ ship the CLI plan

∴ Thinking (^o to expand)

⏺ Reading P-cli. Five tasks, three still open.
⏺ get_plan(P-cli)
  ⎿  state accepted · 5 tasks · 2 merged, 3 todo
⏺ Task(executor #43)
    ● #43  executor     P-cli · execute plan                    9m  $0.84
    └ ⚑ #45  implementor  T-0006 chat + runs           asks you  2m  $0.11

✻ Cogitating (1m 12s · 3 agents · $2.04 · /cancel to stop)
```

- `❯` is you, `⏺` is an agent turn and a tool call, `∴` is a thinking block.
  A built-in tool is title-cased the way Claude Code writes it (`Read`,
  `Bash`, `Task`); an orchestrator or MCP tool keeps the name it was given.
- A call's dot blinks while the call is out, then turns green — or red when
  the tool reported an error. A call the run never answered settles when the
  run stops: red if the run broke, dim if it simply ended. Nothing pulses
  forever.
- A child row inside a transcript drops the words `running` and `idle`: the
  glyph in front of it already says them, and the title wants the column. The
  floor keeps them, because there the word is the only state it has.
- One `⎿` line carries the first line of the result; `^o` opens the rest,
  the arguments the call line had no room for, and the reasoning.
- Two things have no Claude Code counterpart and keep the cockpit's own
  shapes: a spawned child is a live row inside its parent's transcript, and a
  question is loud, with `⚑` and the key that answers it.
- The live line under the transcript belongs to the open run: its verb is a
  pure function of the run id, so it never resamples itself mid-turn.

## Keyboard contract

PRD §6.3. `^x` is Ctrl-X.

| Key | Chat | Floor | Needs you | Jump |
|---|---|---|---|---|
| `↵` | send | talk to row | answer / open | open |
| `esc` | clear the `@#id` chip, then clear the input | back | back | close |
| `tab` | complete the command word, then address the next waiting agent; completes a `/model` suggestion while one is up | — | — | — |
| `↑` `↓` | recall history (walk `/model` suggestions while one is up) | move | move | move |
| `←` `→` | move the cursor · `⌥←` `⌥→` by word · `home`/`end`, `^a`/`^e` to the ends | — | — | — |
| `backspace` / `del` | erase behind / at the cursor · `⌥⌫` or `^w` kills a word | — | — | — |
| `^f` | toggle floor (global) | | | |
| `^n` | toggle needs you (global) | | | |
| `^k` | toggle jump palette (global) | | | |
| `^b` | toggle the rail (global; auto on at ≥110 columns) | | | |
| `^o` | expand thinking, tool arguments and the whole result | — | — | — |
| `^c` | quit — agents keep running | | | |
| `c` | — | cancel subtree (confirm) | — | — |
| `n` | — | new agent | — | — |
| `d` | — | — | dismiss (this session; back on restart) | — |
| `o` | — | open PR / run URL | open PR / run URL | — |
| `pgup`/`pgdn` | scroll the transcript | — | — | — |

Slash commands in the composer (PRD §6.4): `/floor` `/inbox`
`/new <persona> <goal>` `/open #id` `/say <id> <message>` `/spawn <persona>
<goal|T-id>` `/cancel` `/model <id>` `/budget <usd|turns>` `/trace` `/quit`.
Typing `/` lists the matching commands with one-line help above the prompt,
and `tab` completes a half-typed command word.

## Verbs

PRD §6.5. Every listing verb honours `--json`. Output goes to stdout, diagnostics
to stderr. Exit codes: **0** ok, **1** user error, **2** server error.

| Command | What it does |
|---|---|
| `orch` | Open the TUI on the last top-level run you talked to. |
| `orch "<goal>" [-p <persona>]` | Start a top-level run with that persona's defaults, then open it in the TUI. Defaults to the concierge. |
| `orch open <id>` | Open the TUI focused on run `<id>`. |
| `orch floor [--json]` | The run forest, one row per run: glyph, id, persona, title, PR + CI, status, age, subtree cost. |
| `orch inbox [--json]` | What needs you — questions, PRs ready for review, stuck runs, budget warnings. |
| `orch say <id> "<text>"` | Send a message to a run, or answer its pending question. |
| `orch tail <id> [--json]` | Follow a run's transcript + events until `^c`, one line per frame. |
| `orch new <persona> "<goal>"` | Start a run, print its id, detach. |
| `orch spawn <id> <persona> <goal\|T-id>` | Ask run `<id>` to delegate to a child agent. |
| `orch cancel <id>` | Cancel a run (and its subtree). |
| `orch task …` | The existing `cli.ts` verbs, delegated unchanged — `npm run task -- …` keeps working. |

Run states (PRD §6.2): `●` running · `◐` preparing · `○` queued · `⚑` parked on
a question · `◌` idle · `✓` completed · `✕` failed / cancelled / budget
exhausted.

## Terminal size and colour

T-tui-13. Two claims: nothing overflows at 80×24, 100×30 or 160×50, and the
six hues degrade deliberately on a 16-colour terminal.

### Size

Every region's geometry is a pure function in `src/views/layout.ts` (rows,
needs-you rows, the chat header, the floor and needs-you headings, the palette,
the composer's help, nudge and key hints, the rail's window) or in
`src/views/transcript.ts` (the frame lines). `test/views/screen.test.ts` runs
all of them at the three sizes, under both glyph tables, over the mock
fixtures *and* an adversarial forest — ten levels of nesting, four-digit run
ids, a 35-character persona, a 99-character title, `PR#31245` with a CI mark
and `$1234.56` — and asserts that nothing produces more columns than it was
given, plus that `bodyH` + the composer + header/hair/status never exceeds the
rows there are. `test/views/render.test.ts` then renders the whole cockpit
through Ink onto a fake 80×24 / 100×30 / 160×50 stream (chat, floor, needs
you, jump, the composer's help list, and 80×24 again under `--ascii`) and
measures the frame Ink actually writes.

What that pass changed, beyond the tests:

- a four-digit run id used to be clipped to `#123` in floor and needs-you
  rows — a wrong id, not a narrow one. The id cell grows and the title pays;
- the chat header's right-hand tally (age, agents, model, budget, spend) is
  capped at half the width, so a long model id can no longer push the run's
  own name out of its own header;
- the floor's key hints drop from the right instead of wrapping the header
  onto a second line (at 80 columns `esc back` is the one that goes);
- the command help under the composer yields before the transcript does on a
  short terminal;
- the jump palette's rows come out of the transcript's budget instead of
  pushing the status line off a 24-row screen, and its border follows
  `--ascii` (Ink's `classic` style) like every other rule.

**Still needs a human at a real terminal**: how it *feels* — whether the
80-column floor row is readable rather than merely inside its budget, and
whether an emulator with a different font metric (a double-width glyph, a
non-monospace fallback for `⚑` or `⎿`) still lines up. The suite counts
characters, not cells.

### Colour

The palette lives in `src/model/colors.ts` and reaches the views through one
accessor (`C`, and `statusColor` for run state). Nothing else names a colour.

| Hue | Means | 24-bit | on black | on white | 16-colour | chalk would have picked |
|---|---|---|---|---|---|---|
| `running` | running, preparing | `#c68108` | 6.5 | 3.2 | `yellow` | `yellow` |
| `review` | parked on a question, the `@#id` chip | `#a662ea` | 5.6 | 3.8 | `magentaBright` | `magentaBright` |
| `blocked` | failed, cancelled, CI red | `#e25050` | 5.5 | 3.8 | `redBright` | `red` |
| `done` | completed | `#29a46a` | 6.6 | 3.2 | `green` | `green` |
| `queued` | queued, idle | `#8f8f97` | 6.5 | 3.2 | `gray` | `white` |
| `you` | your turns, the prompt caret | `#6092dd` | 6.7 | 3.2 | `blueBright` | `cyan` |
| `muted` | secondary text | `#808080` | 5.3 | 3.9 | `gray` | `white` |
| `hair` | rules | `#3a3a3f` | 1.9 | 11.3 | `gray` | `black` |
| `fg` | primary text | *the terminal's own* | — | — | *the terminal's own* | — |

Contrast is WCAG 2.1 against a pure black and a pure white background, and
`test/model/colors.test.ts` computes it rather than trusting the table: every
hue must clear 4.5:1 on black and 3:1 on white. The 16-colour column is scored
against the xterm defaults, which is the worst case — a terminal theme remaps
those names, which is exactly why the fallback names colours instead of
stating hexes.

Four hues were **darkened 4–19 %** in this pass. `#f59f0a`, `#2eb877`,
`#6ea8fe` and `#95959d` scored 2.1–3.0:1 on a white background: amber and
mid-blue on white is the classic unreadable case, and a status glyph you
cannot see is a status you do not have. They still clear 6.5:1 on black.
`fg` was `"white"`, which on a light theme is ANSI 37 — 1.8:1 against the
background, i.e. invisible. It is now unset, so the terminal's own foreground
is used and both themes work.

The last column is the point of having a fallback at all: chalk *does*
quantise a hex on its own, by rounding each channel, and on four of the eight
it lands somewhere the vocabulary did not intend — `blocked` on plain red
(1.9:1 on a black terminal: a failed run you cannot see), `queued` and `muted`
both on white (1.8:1 on a light one), and `you` on cyan, which is a different
hue rather than a dimmer blue. The named palette is picked instead whenever
the terminal is at 16 colours or fewer; at 256 chalk's own downsample keeps
the hue, so the 24-bit table stays. `you` is the one compromise in the
fallback: every blue in the ANSI sixteen is dark (`blue` is 1.3:1 on black at
the xterm defaults), so bright blue is the least bad — 8.6:1 on white, a dim
2.4:1 on a stock black terminal, and brighter than that under any theme that
remaps it.

The mode is detected the way chalk detects its level, as a pure function over
the environment: `ORCH_COLORS`, then `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`,
`TERM`. chalk's own `chalk.level` is not read — chalk is not a dependency of
this package, it only arrives under `ink`, and the detection has to be
testable against a fake environment anyway. Override it with:

```bash
orch --16color                  # anywhere before the verb
ORCH_COLORS=16 orch             # or truecolor, to force the other way
npm run mock -- --16color       # look at it without a 16-colour terminal
```

**Still needs a human at a real terminal**: a light theme that is not pure
white (Solarized Light's `#fdf6e3`) and a dark theme that is not pure black
(`#1e1e1e`), plus how the named fallbacks land in *that* terminal's palette —
the ratios above are computed against the extremes and the xterm defaults, and
the extremes are where a colour is hardest.

## Development

```bash
npm run mock        # the views against fixture data, no server
npm run orch        # the real thing
npm run typecheck   # tsc --noEmit
npm test            # vitest (hermetic: loopback servers, no Postgres)
npm run build:orch  # then smoke it: cd $(mktemp -d) && node .../dist/orch.js --help
```

CI runs typecheck, tests and the bundle smoke test in the dedicated `tui` job
(`.github/workflows/ci.yml`) — this package is excluded from the root
`tsconfig.json` and the root vitest `include`, so it would otherwise have no
coverage.

## Why not a workspace

PRD §8 called for `tui/` as a root npm workspace. It is not one, and the root
`package.json` has no `workspaces` array at all. Adding one costs more than it
buys:

- **Every image build breaks.** `Dockerfile.server`, `Dockerfile.worker` and
  `Dockerfile.fly-runner` all do `COPY package.json package-lock.json .npmrc ./`
  followed by `npm ci` — with no `tui/package.json` in that layer, `npm ci`
  fails on a declared-but-absent workspace. Each Dockerfile would need an extra
  COPY, and the worker/runner images would then carry `ink` for nothing.
- **The Next build's React would move.** Hoisting merges `react@^19.2.0` (tui)
  with `react@^19.0.0` (root) into one root `node_modules/react`. The Next app
  currently resolves its own; there is no reason to make a terminal UI's
  dependency bump able to shift it.
- **The root lockfile churns.** 423 KB of `package-lock.json` regenerates, and
  `tui/package-lock.json` — which the `tui` CI job caches and installs from —
  becomes ambiguous.
- **The isolation is already the design.** `tui` is in the root `tsconfig.json`
  `exclude` list next to `mobile/`, and has its own vitest config and CI job.
  A separate install matches that.

The only thing a workspace bought was `npm install` at the root installing
`tui/` too. `cd tui && npm ci` does that, and the packaging above (a self
contained bundle, a `bin` shim with absolute paths) means nothing else depends
on hoisting.
