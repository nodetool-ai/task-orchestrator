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

A 401 prints one line on stderr naming the fix and exits 1 — it never opens an
empty cockpit.

```bash
export ORCH_URL=https://tasks.nodetool.ai
export ORCH_TOKEN=…
orch floor
```

## Keyboard contract

PRD §6.3. `^x` is Ctrl-X.

| Key | Chat | Floor | Needs you | Jump |
|---|---|---|---|---|
| `↵` | send | talk to row | answer / open | open |
| `esc` | clear the `@#id` chip, then clear the input | back | back | close |
| `tab` | address the next waiting agent | — | — | — |
| `^f` | toggle floor (global) | | | |
| `^n` | toggle needs you (global) | | | |
| `^k` | toggle jump palette (global) | | | |
| `^b` | toggle the rail (global; auto on at ≥110 columns) | | | |
| `^o` | toggle the full tool trace | — | — | — |
| `^c` | quit — agents keep running | | | |
| `c` | — | cancel subtree (confirm) | — | — |
| `n` | — | new agent | — | — |
| `d` | — | — | dismiss | — |
| `o` | — | open PR / run URL | open PR / run URL | — |
| `pgup`/`pgdn` | scroll the transcript | — | — | — |

Slash commands in the composer (PRD §6.4): `/floor` `/inbox`
`/new <persona> <goal>` `/open #id` `/spawn <persona> <goal|T-id>` `/cancel`
`/model <id>` `/budget <usd|turns>` `/trace` `/quit`. Typing `/` lists the
matching commands with one-line help above the prompt.

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
