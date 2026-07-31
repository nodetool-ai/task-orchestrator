# Discord Persona Bots — Design

**Date:** 2026-07-31
**Status:** Draft
**Scope:** Turn the single-bot Discord bridge (`lib/pipe/`) into a
persona-based messaging system: each persona is its own Discord bot,
persona conversations run in-process without containers, personas use
memory heavily (new persona/user memory scopes), and personas orchestrate
plans, tasks, and containerized agent runs on the user's behalf.

## Motivation

Today users drive the orchestrator through the web UI, the CLI, or one
anonymous Discord bot. The vision (see `ideas/principles.md` §personas,
`ideas/lifecycle.md`) is that **personas are the primary interface**: a
user talks to a named, memoryful assistant that knows them, knows the
repos, and quietly operates the machinery underneath — creating plans,
splitting tasks, dispatching implement runs, watching CI, and reporting
back — without the user ever touching a run detail page.

Discord is the natural first surface:

- **One bot per persona.** Each persona appears as a distinct Discord
  user (own name, avatar, presence). Talking to "Pia the planner" vs
  "Rex the reviewer" is picking a different bot, not typing a flag.
  Personas can even be @-mentioned into each other's threads later.
- **Personas are conversational, not batch.** A persona turn is a chat
  turn: no repo checkout, no branch, no PR. Spinning up a Fly machine or
  Docker container per message is the wrong cost/latency shape. Persona
  turns run **in-process** in the pipe/server process; only spawned
  agent runs (implement/review/execute) keep the worker-container tier.
- **Memory is the product.** A persona that forgets the user's
  preferences, active plans, and past decisions each thread is a toy.
  The `memories` table + BM25 search exists but only scopes
  `global|repo|task` — two personas on the same repo share one memory,
  and nothing is remembered *about a user*. We add `persona` and `user`
  scopes and mount them ambiently on every turn.

## Non-goals

- Slack/Telegram adapters. The `Channel` interface stays pluggable but
  only Discord ships here.
- Voice, attachments-out, or rich embeds beyond what `lib/pipe/render.ts`
  already does.
- Persona-to-persona autonomous conversation. Personas may spawn runs
  (including executor runs that themselves spawn children), but two
  Discord bots chatting to each other is out of scope.
- Multi-tenant Discord. One orchestrator deployment ↔ one Discord
  guild/user community, same trust model as today's allowlist.
- Reviving the in-process tier for *implement* work. Anything that
  writes to a repo or runs shell still goes through a worker container.

## Background — what exists

- **Discord bridge:** `lib/pipe/` (port of `georgi/claude-pipe`), run by
  `npm run pipe` (`scripts/pipe.ts`) as a separate long-lived process.
  One `DiscordChannel` (discord.js gateway), one `AgentLoop`,
  `channel_threads` mapping `(channel, externalId)` → run id,
  per-conversation serialization, throttled draft edits, 2000-char
  chunking, mandatory `DISCORD_ALLOWED_USERS` allowlist.
- **Personas:** `personas` table + `lib/personas/*` TS seeds +
  `personaPromptFactory` / `personaMemoryFactory` extensions.
  `runs.create` and `POST /api/runs` already accept `personaId`.
  `lib/personas/executor.ts` already describes the orchestration
  behavior we want (list tasks, spawn children, park on timers, wake on
  `child.result` / CI inbox events).
- **In-process execution:** `sendMessageToRun` (`lib/runs.ts`) already
  falls back to a full in-process turn when `remoteRunnerEnabled()` is
  false — this is how the pipe works today. A dedicated DB-backed
  in-process loop exists at `lib/agent-backend/postgres-turn.ts`
  (rebuilds the conversation from `agent_messages` each turn, no SDK
  session file, no worktree) but is switched off
  (`const usePostgres = false`, `lib/runs.ts:3392`).
- **Orchestration tools:** `lib/orchestrator-tools.ts` (plans/tasks/
  sessions CRUD + `start_session`/`await_session`), `lib/extensions/
  spawn.ts`, `lib/extensions/events.ts` (timers, inbox poll/emit,
  `report_result`).

### Gaps this design closes

1. One bot token, one loop — no persona dimension anywhere in the pipe.
2. `channel_threads` unique on `(channel, externalId)` — can't have two
   personas each holding a conversation in the same Discord channel.
3. Discord runs are anonymous: `session-store.ts` calls
   `createChat(null, …)`, so `agent_runs.user_id` is NULL and nothing
   links a Discord snowflake to a `users` row.
4. In-process vs container is a **global** env switch
   (`remoteRunnerEnabled()`), not a per-run property — we can't say
   "persona chats in-process, their spawned implement runs in
   containers" in one deployment.
5. Memory scopes are `global|repo|task` only — no per-persona, no
   per-user memory.

## Design

### 1. Persona ⇄ bot binding

Each persona that should be reachable on Discord gets its own Discord
application + bot token. Binding is **config, not schema**: tokens are
secrets and don't belong in Postgres.

```
# .env — one token per persona id (upper-snake), discovered at boot
DISCORD_BOT_TOKEN_PLANNER=...
DISCORD_BOT_TOKEN_IMPLEMENTOR=...
DISCORD_BOT_TOKEN_QA=...

# existing globals still apply as defaults
DISCORD_ALLOWED_USERS=...        # mandatory, as today
DISCORD_ALLOWED_CHANNELS=...     # optional
# optional per-persona overrides
DISCORD_ALLOWED_CHANNELS_QA=...
```

`loadPipeConfig()` (`lib/pipe/config.ts`) changes from a single
`DiscordConfig` to `bots: PersonaBotConfig[]`, where each entry is
`{ personaId, token, allowedUsers, allowedChannels }`. Boot validates
every `personaId` against `repo.listPersonaIds()` and refuses to start
on an unknown persona or an empty user allowlist (unchanged security
posture). The legacy `DISCORD_BOT_TOKEN` maps to the default persona
(`DISCORD_DEFAULT_PERSONA`, falling back to `implementor`) so existing
deployments keep working.

`scripts/pipe.ts` constructs one `DiscordChannel` + one `AgentLoop`
**per bot**, all inside the single pipe process. `DiscordChannel` and
`AgentLoop` each gain a `personaId` field; everything else about the
adapter (gateway client, auto-threading, draft edits, chunking,
serialization) is already per-instance and needs no change.

Multiple gateway clients in one process is fine (discord.js clients are
independent); each bot only sees messages in channels it was invited
to, and the existing "respond only in DMs / when mentioned / in own
thread" rules keep two personas in one channel from double-answering.

### 2. Conversation identity and attribution

**Schema:**

```sql
ALTER TABLE channel_threads ADD COLUMN persona_id TEXT REFERENCES personas(id);
ALTER TABLE channel_threads ADD COLUMN user_id INTEGER REFERENCES users(id);
-- replace UNIQUE(channel, external_id) with UNIQUE(channel, external_id, persona_id)

CREATE TABLE channel_identities (
  id SERIAL PRIMARY KEY,
  channel TEXT NOT NULL,            -- 'discord'
  external_user_id TEXT NOT NULL,   -- Discord snowflake
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT,                       -- e.g. discord username at link time
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel, external_user_id)
);
```

`channel_identities` maps a Discord user to a `users` row. Linking is a
one-time `/link <token>` slash/text command: the user mints an API
token in the web UI (`/api/tokens`, existing) and pastes it in a DM;
the pipe verifies it via `lib/api-tokens.ts` and inserts the identity
row. Unlinked users can still talk (allowlist permitting) but their
runs stay unattributed, exactly like today — linking upgrades
attribution, it doesn't gate access.

`lib/pipe/session-store.ts#getOrCreateRun` gains `personaId` and looks
up `userId` from `channel_identities`, then creates the conversation
via `runs.create({ goal: "<chat>", personaId, userId,
runtime: "server", cwdStrategy: "none",
toolsProfile: persona.toolsProfile, backend: persona.backend, … })`
instead of `chat.createChat(null, …)`. `agent_runs.user_id` and
`persona_id` are then real, so persona conversations show up in the
user-scoped `/api/chats`-equivalent listings and the web UI.

### 3. Containerless persona turns (runtime as a per-run property)

Today `runs.create` hardcodes `runtime: "worker"` and the in-process
path is only reachable when `remoteRunnerEnabled()` is globally false.
We make runtime a real per-run decision:

- `CreateRunInput` accepts `runtime?: "worker" | "server"`; default
  stays `"worker"`. The pipe passes `"server"` for persona chats.
  `POST /api/runs` does **not** expose `runtime` (server-side callers
  only) — an external caller must not be able to opt a run into the
  server process.
- `sendMessageToRun` branches on `run.runtime === "server"` (falling
  back to the current global check for legacy rows): server-runtime
  runs always execute the in-process `append()` path, even when a
  remote runner is configured. Worker-runtime runs dispatch exactly as
  today.
- `runOneTurn` un-hardcodes `usePostgres`: server-runtime runs on the
  pi backend use `lib/agent-backend/postgres-turn.ts` — the
  conversation is rebuilt from `agent_messages` every turn, so persona
  conversations survive process restarts, have no SDK session file on
  disk, and never need a worktree (`cwdStrategy: "none"`).
  (`claude-backend` still rejects postgres mode; persona rows that
  want it must use `backend: "pi"` — seed personas accordingly. A
  claude-backend equivalent is future work.)
- The pending-run pump ignores server-runtime runs (they are driven by
  inbound messages and inbox events, not by dispatch).

Guardrail: `runs.create` **rejects** `runtime: "server"` when the
requested `toolsProfile` includes any repo-writing or shell-capable
profile (`repo_write`, and anything mounting bash/fs tools). The
in-process loop runs with the server's own privileges — the whole
point of the worker split — so server-runtime is reserved for
tool-mediated orchestration profiles. This replaces the pipe's current
"full shell in the server checkout" posture; see §6.

### 4. Heavy memory: persona and user scopes

`memories.scope` grows from `global|repo|task` to
`global|repo|task|persona|user` (`scopeKey` = persona id / user id).
Changes in `lib/extensions/persona-memory.ts`:

- `scopeSpecs` derives from the run row: `global` + `repo:<repoId>` +
  `task:<taskId>` (as today) **+ `persona:<personaId>` +
  `user:<userId>`** when set.
- `memory_remember` accepts the two new scopes; guidance text tells
  personas to default personal facts about the interlocutor to `user`
  scope and their own working style/decisions to `persona` scope.
- The ambient mount grows: recent `persona` and `user` memories are
  always rendered into the `persona-memory-<id>` skill, and
  `memory_search` searches all visible scopes. The 12-entry recency cap
  becomes per-scope-group so a chatty repo can't evict user memories.
- Every persona turn additionally auto-searches memory with the inbound
  message text and prepends top hits (the claude-pipe
  `buildModelInput` pattern) — memory is *pushed* into context, not
  just available behind a tool, which is what "use memory heavily"
  requires in practice.

Since worker runs already carry `personaId` (and now `userId` flows in
when a persona spawns on a user's behalf), spawned implement runs see
the same persona/user memories through the identical extension — the
persona's knowledge travels into its delegated work for free.

### 5. Personas orchestrate: tools and progress relay

**Tools.** Discord-facing personas get
`toolsProfile: "orchestrator,spawn"` (plus `planning` where relevant):
full plans/tasks/criteria/notes CRUD, `start_session` /
`await_session` / `cancel_session`, `spawn__spawn_agent`, timers, and
inbox tools — everything `executor.ts` already exercises. A persona
asked "ship dark mode" can: search memory → create/find the plan →
create tasks with acceptance criteria → `start_session` an implementor
(a normal **worker-runtime containerized run**) → park → report the PR
link when the child's `child.result` lands.

**Progress relay.** A parked persona only speaks when its run produces
output, but users expect ambient progress ("PR opened", "CI failed").
The pipe process subscribes to the existing in-process run event bus
(`runs.subscribe`) for every run whose `channel_threads` row it owns.
Two behaviors:

- **Inbox echo:** when an inbox event (`child.result`, `gh.pr.merged`,
  CI failure) is injected into a persona's run, the resulting agent
  turn streams to the Discord thread exactly like a user-prompted turn
  — this already works because injection goes through the same
  `append()` path. The persona narrates its own progress.
- **Passive breadcrumbs:** for cheap signals not worth an agent turn
  (child status transitions), the relay posts a small plain message to
  the thread directly (`⏳ implementor run #123 started on T-…`,
  `✅ PR opened: <url>`). Formatting lives in `lib/pipe/render.ts`;
  events are matched via `parentRunId` → owning persona run →
  `channel_threads` row.

**Lifecycle.** One persona conversation = one long-lived server-runtime
run per Discord thread (existing auto-thread behavior). `/new` resets
the thread to a fresh run (existing). Because context is rebuilt from
Postgres each turn, long threads eventually need compaction: reuse the
transcript-summarization approach from the planning agent (summarize
`agent_messages` older than N turns into a synthetic system block) —
kept simple in v1: hard cap with a "start a /new thread" nudge, real
compaction as follow-up.

### 6. Security posture

- In-process persona turns run inside the pipe/server process with
  `DATABASE_URL` in reach. Mitigations: (a) the §3 guardrail — no
  shell/fs/repo_write profiles on server runtime, tools only; (b) the
  mandatory per-bot user allowlist stays; (c) `runtime` not settable
  via public API.
- The pipe's current "chat = full shell in the default checkout" mode
  is retired for persona bots. Users who want hands-on-repo work ask
  the persona to spawn a run — which is containerized, branch-isolated,
  and PR-reviewed like all agent work.
- `/link` consumes a bearer token over DM only (never guild channels)
  and stores only the hash-verified association, not the token.
- Memory writes attribute `author` from the linked user or
  `discord:<username>`, unchanged.

## Migration / rollout

1. Schema migration (`channel_threads` columns + backfill
   `persona_id = 'implementor'`, new unique index, `channel_identities`,
   widened `memories.scope` check).
2. Runtime plumbing (`runtime` on `CreateRunInput`, branches in
   `sendMessageToRun` / `runOneTurn`, pump exclusion, profile guardrail).
3. Memory scopes + auto-search injection.
4. Pipe multi-bot refactor + `/link`.
5. Progress relay.
6. Seed a first-class conversational persona (e.g. `concierge`) with
   `toolsProfile: "orchestrator,spawn"`, `backend: "pi"`, and a system
   prompt oriented at end users rather than contributors.

Existing single-bot deployments keep working throughout (legacy env
mapping, backfilled persona id, unchanged worker tier).

## Open questions

- Should two personas be able to *share* a thread (user mentions a
  second bot inside the first bot's thread)? The unique key allows it;
  the UX needs thought — deferred.
- Compaction strategy for very long persona threads (v1 nudges `/new`).
- A claude-backend equivalent of `postgres-turn.ts` so personas aren't
  pi-only.
- Per-guild (multi-community) config if this ever leaves single-tenant.
