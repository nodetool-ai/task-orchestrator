# TASKS — terminal cockpit (`orch`)

Source: [PRD.md](PRD.md). Milestones M1–M4 as in PRD §9. Each task lists
acceptance criteria; a task is done when all are true. IDs are local to this
file until they are created in the orchestrator (`npm run task -- new task`).

## M1 — Read-only cockpit

### T-tui-01 API client
- `tui/src/api/client.ts` wraps fetch + SSE with `ORCH_URL`, `ORCH_TOKEN`.
- Typed functions: `overview()`, `run(id)`, `runEvents(id, cursors)`,
  `runInbox(id)`, `listRuns()`.
- SSE reconnects with the last cursor after a drop; backoff 1 s → 30 s.
- Unit tests with a fake server (vitest) cover reconnect and 401.

### T-tui-02 Floor + rail on live data
- Floor and rail render from `overview()`, live via `overview/events`.
- Tree order: live subtrees first, then earlier; children stay under parents.
- Row shows glyph, id, persona, title, PR + CI, status word, age, subtree cost.
- Holds at 80 columns without wrap; rail hides below 110.

### T-tui-03 Transcript on live data
- Chat view renders `runEvents` for the current run: user, agent, tool,
  spawn, event, question frames.
- Spawn frames render the child subtree live from overview data.
- `^o` toggles full tool trace; default is one line per tool call.
- Scroll: transcript tails to bottom; `pgup/pgdn` scroll back.

### T-tui-04 Global inbox endpoint
- Server: `GET /api/inbox?audience=owner` returns pending inbox events across
  live runs, newest first, with run id, persona, kind, text, age.
- Covered by a route test.
- TUI needs-you view and the `⚑ n` counts read from it.

### T-tui-05 Jump palette
- `^k` palette over runs, tasks, plans from `/api/runs`, `/api/tasks`,
  `/api/plans` (cached for 30 s).
- Fuzzy match on id and title; `↵` on a run opens its chat; on a task opens
  its attached run if any, else shows the task id in the status line.

## M2 — Talk

### T-tui-06 Send and answer
- `↵` posts to `/api/runs/:id/messages`; the frame appears optimistically
  and reconciles with the stream.
- `tab` cycles waiting agents; `@#id` chip; `↵` posts to that run; the chip
  clears; the question frame shows `↳ you: …`.
- `esc` clears the chip first, then the input.

### T-tui-07 New, open, cancel
- `/new <persona> <goal>` → `POST /api/runs` with the persona's defaults; the
  TUI switches to the new run.
- `/open #id` switches the conversation; header shows the parent breadcrumb.
- `/cancel` and floor `c` → `PATCH /api/runs/:id` cancel, with a one-line
  confirm for subtrees with live children.
- `orch "<goal>"` and `orch open <id>` call the same code paths.

### T-tui-08 Spawn
- `/spawn <persona> <goal|T-id>` posts a user message that asks the current
  orchestrator to delegate (the agent owns the `spawn` tool); the TUI does
  not create child runs itself.
- The resulting spawn frame appears in the transcript within one stream tick.

## M3 — CLI verbs and packaging

### T-tui-09 CLI verbs
- `orch floor|inbox|tail|say|new|spawn|cancel|open`, all `--json` where they
  list, exit codes 0/1/2, stdout data only.
- `orch tail <id>` follows until `^c`; prints frames in the same one-line
  format as the TUI tool lines.
- `orch task …` delegates to `cli.ts` so `npm run task -- …` behaviour is
  unchanged.

### T-tui-10 Packaging
- `tui/package.json` has `bin: { orch }`; `npm run orch` from the repo root.
- `npm run build:orch` bundles to `dist/orch.js` with esbuild; the Fly image
  includes it.
- Workspace wiring: `tui` added to root `workspaces` (or documented as a
  standalone install if the root stays non-workspace).
- `tui/README.md` covers install, env vars, keys, verbs.

### T-tui-11 Auth
- `ORCH_TOKEN` sent as Bearer; 401 prints a one-line fix
  (`npm run task -- user link …` or token page).
- Local dev with no token works against the dev server.

## M4 — Polish

### T-tui-12 Model, budget, trace, open
- `/model <id>` and `/budget <usd|turns>` patch the run; header reflects it.
- `o` opens the PR or run URL in the browser from floor and needs-you.
- `--ascii` flag swaps glyphs for ASCII; box drawing falls back to `|-`.

### T-tui-13 Small terminals and colour
- Manual pass at 80×24, 100×30, 160×50; no horizontal overflow anywhere.
- 16-colour pass: the six hues map to the nearest ANSI colours; contrast
  checked on a dark and a light terminal theme.

### T-tui-14 Docs and hand-over
- `docs/tui.md` in the repo root docs: what `orch` is, when to use it over
  the web, the keyboard contract, the verb table.
- README links to it. DESIGN.md in `tui/` marked as historical.
