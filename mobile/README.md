# Pi Factory — mobile

An Expo (SDK 56) client for the Task Orchestrator, matching the
**Pi Factory** mobile design prototype. It reuses the existing Next.js REST
API — no backend changes — and puts the operator surface (the "factory
floor") on a phone.

## Screens

| Screen | What it shows | Source endpoints |
|--------|---------------|------------------|
| **Floor** (`/`) | Status strip (Running / Review / Stuck / Queue / Shipped), cost + token totals, live run cards, review queue, stuck runs, shipped today | `GET /api/sessions`, `GET /api/tasks`, `GET /api/plans` |
| **Review** | PRs waiting on you (tasks in `testing`/`failing`/`passing`), swipe to merge / request changes | `GET /api/tasks`, `POST /api/tasks/:id/transition` |
| **Queue** | Todo tasks ready to spawn, filtered by plan; tap a card to open the task | `GET /api/tasks` |
| **Plans** | Active + shipped plans with progress | `GET /api/plans`, `GET /api/plans/:id` |
| **Task detail** (`/task/:id`) | State (change via the real transition map), assignee, plan, repo, PR, tags, dependencies; markdown description; acceptance criteria (tap to toggle, add); notes (add); agent-run inbox; and **Run agent** — the full agent picker + optional first message | `GET /api/tasks/:id`, `POST /api/tasks/:id/{transition,criteria,notes}`, `PATCH /api/tasks/:id/criteria/:cid`, `POST /api/tasks/:id/attached-run`, `POST /api/runs/:id/messages` |
| **Run detail** (`/run/:id`) | Spend, the shared chat transcript (markdown, tool groups, images), and the intervention surface: send instructions, tick acceptance criteria, approve planning gates, stop / resume / close | `GET /api/runs/:id`, `PATCH /api/runs/:id`, `POST /api/runs/:id/messages`, `POST /api/runs/:id/planning`, `PATCH /api/tasks/:id/criteria/:cid`, `POST /api/sessions/:id/resume` |
| **Plan detail** (`/plan/:id`) | Goal/approach, active runs, queued + shipped tasks (tap to open) | `GET /api/plans/:id` |
| **Spawn** (center tab button) | Pick a task + the full agent picker (persona · engine · model · reasoning) + budget and launch | `GET /api/personas`, `GET /api/providers`, `POST /api/runs` |

Pull-to-refresh and an 8s background poll keep everything live. Search,
spawn, resume and settings are bottom sheets.

The **agent picker** (`src/components/AgentPicker.tsx`) and the **chat
transcript** (`src/components/Transcript.tsx`) are shared: the picker drives
every run-start surface (Spawn, task Run-agent), and the transcript renders the
same message model — user bubbles, markdown agent prose, collapsible tool
groups, images and system rows — everywhere a conversation appears. Task state
mirrors the server machine exactly (`src/lib/task-state.ts`).

## Design fidelity

The visual system is ported 1:1 from the prototype (`mobile-*.jsx`):

- the dark/light palette (`src/theme/colors.ts`) is the prototype's CSS
  variables verbatim;
- Linear-style status glyphs, persona chips, sparklines, progress bars and
  the pi brand mark are reimplemented with `react-native-svg`
  (`src/components/Icon.tsx`, `StateIcon.tsx`, `primitives.tsx`);
- frosted headers and tab bar use `expo-blur`;
- the raised center **Spawn** action, swipe-to-act cards and slide-up sheets
  match the mockup interactions.

## Auth

HTTP access is gated by the orchestrator's Auth.js (next-auth v5) credentials
provider. On the login screen you enter the **server URL** + **email** +
**password**; the app performs the CSRF + credentials handshake and the native
cookie jar carries the session for subsequent requests. Create accounts on the
server with `npm run task -- user add you@example.com`.

## Run it

```bash
cd mobile
npm install
npx expo start          # then press i / a, or scan the QR with Expo Go
```

Point it at a running orchestrator (`npm run dev` in the repo root, reachable
from the device — e.g. `http://<your-lan-ip>:3000`, or the production
`https://tasks.nodetool.ai`).

## Stack

- Expo SDK 56 · React Native 0.85 · expo-router (file-based)
- `react-native-svg`, `expo-blur`, `@react-native-async-storage/async-storage`
- No state library — a small polling `DataProvider` + pure selectors in
  `src/lib/model.ts` that bucket the REST payloads the same way the server's
  own Floor projection (`lib/pi-floor-data.ts`) does.

## Layout

```
src/
  app/                 expo-router routes (tabs, run/[id], plan/[id], login)
  components/          Icon, StateIcon, cards, sheets, shell, primitives…
  data/                Auth / Data / Sheets providers
  lib/                 api client, types, view-model selectors, formatters
  theme/               palette + ThemeProvider
```
