# Discord Persona Bots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each persona becomes its own Discord bot. Persona conversations are long-lived `agent_runs` with `runtime: "server"` executed in-process (no container) via the revived `postgres-turn` loop, attributed to real users, with new `persona`/`user` memory scopes mounted ambiently. Personas orchestrate plans/tasks and spawn containerized worker runs; child progress is relayed back to the Discord thread.

**Architecture:** `lib/pipe/` grows from one `(DiscordChannel, AgentLoop)` pair to N pairs (one per persona bot token) in the single pipe process. `channel_threads` gains `persona_id`/`user_id`; a new `channel_identities` table links Discord snowflakes to `users` via `/link <api-token>`. `runs.create` accepts `runtime: "server"` (internal callers only, orchestration-only tools profiles enforced); `sendMessageToRun`/`runOneTurn` branch on `run.runtime` instead of the global `remoteRunnerEnabled()`, with server-runtime pi runs using `lib/agent-backend/postgres-turn.ts`. Memory scope set widens to `global|repo|task|persona|user` with auto-search injection per turn. A relay in the pipe subscribes to `runs.subscribe` and posts child-run breadcrumbs to owning threads.

**Tech Stack:** TypeScript, Next.js 15, Drizzle (Postgres), discord.js 14, `@earendil-works/pi-coding-agent`, Vitest. Existing: `lib/pipe/*`, `lib/runs.ts`, `lib/run-dispatch.ts`, `lib/agent-backend/postgres-turn.ts`, `lib/extensions/persona-memory.ts`, `lib/repo.ts`, `db/schema.ts`.

**Source spec:** `docs/superpowers/specs/2026-07-31-discord-personas-messaging-design.md`

---

## File map

**Created:**
- `db/migrations/00XX_persona_messaging.sql`
- `lib/pipe/identity.ts` (channel_identities lookup + `/link` verification)
- `lib/pipe/relay.ts` (child-run breadcrumb relay)
- `lib/personas/concierge.ts`
- `__tests__/pipe-multibot.test.ts`, `__tests__/pipe-identity.test.ts`, `__tests__/run-runtime-server.test.ts`, `__tests__/memory-scopes.test.ts`, `__tests__/pipe-relay.test.ts`

**Modified:**
- `db/schema.ts` (channel_threads cols + unique index, channel_identities, memories scope)
- `lib/repo.ts` (identity CRUD, memory scope plumbing)
- `lib/runs.ts` (`CreateRunInput.runtime`, `sendMessageToRun` branch, `runOneTurn` postgres gate, pump exclusion)
- `lib/run-dispatch.ts` (skip server-runtime rows in pump/reconcile)
- `lib/extensions/persona-memory.ts` (new scopes, per-group recency, auto-search injection)
- `lib/pipe/config.ts` (multi-bot env discovery, legacy mapping)
- `lib/pipe/types.ts` (`PersonaBotConfig`, personaId on inbound)
- `lib/pipe/channels/discord.ts` (personaId field, per-bot allowlists)
- `lib/pipe/agent-loop.ts` (personaId, `/link` command)
- `lib/pipe/session-store.ts` (`runs.create` with personaId/userId/runtime, persona-keyed lookup)
- `lib/pipe/commands.ts` (`/link`, `/whoami` shows linked user + persona)
- `lib/pipe/render.ts` (breadcrumb formatting)
- `scripts/pipe.ts` (N bots, relay wiring)
- `lib/personas/index.ts`, `db/seed-personas.ts` (concierge)
- `.env.example`, `docs/` (pipe docs section)

---

## Milestone 1 — Schema

- [ ] Add `persona_id` (FK personas, nullable) and `user_id` (FK users, nullable) to `channel_threads`; backfill `persona_id = 'implementor'`; replace unique `(channel, external_id)` with `(channel, external_id, persona_id)`.
- [ ] Create `channel_identities` (`channel`, `external_user_id`, `user_id`, `label`, unique `(channel, external_user_id)`).
- [ ] Widen `memories.scope` allowed values to include `persona` and `user` (check constraint / TS validation in `lib/repo.ts`).
- [ ] `npm run db:generate`; migration applies via `initDb()`; tests for identity CRUD in `lib/repo.ts`.

## Milestone 2 — Server runtime as a per-run property

- [ ] `CreateRunInput` gains `runtime?: "worker" | "server"` (default `"worker"`); `runs.create` stops hardcoding. NOT exposed in `POST /api/runs` zod schema.
- [ ] Guardrail: `runs.create` throws if `runtime === "server"` and the tools profile resolves any shell/fs/repo-write capability (introduce a `serverSafe` flag on profile entries in `lib/profiles.ts`).
- [ ] `sendMessageToRun`: `run.runtime === "server"` → always in-process append; `"worker"` → existing dispatch logic (global fallback preserved for legacy rows).
- [ ] `runOneTurn`: `usePostgres = run.runtime === "server" && backend === "pi"`; reject server-runtime on claude backend with a clear error.
- [ ] `startPendingRunPump` / reconciliation in `lib/run-dispatch.ts` skip `runtime = 'server'` rows.
- [ ] Tests: server-runtime run executes in-process with a stubbed backend even when `TASK_ORCH_DETACHED_RUNS=1`; guardrail rejection; pump exclusion.

## Milestone 3 — Memory scopes

- [ ] `lib/extensions/persona-memory.ts`: `scopeSpecs` adds `persona:<personaId>` and `user:<userId>`; `memory_remember`/`memory_forget`/`memory_search` accept the new scopes; guidance text updated (user facts → `user`, persona working style → `persona`).
- [ ] Ambient mount: per-scope-group recency caps so repo memories can't evict user/persona memories.
- [ ] Auto-search injection: on each turn, BM25-search visible scopes with the inbound text and prepend top hits to the model input (postgres-turn and standard path).
- [ ] Tests: scope visibility matrix (two personas / two users don't cross-read), injection content.

## Milestone 4 — Multi-bot pipe + identity

- [ ] `loadPipeConfig()`: discover `DISCORD_BOT_TOKEN_<PERSONA_ID>` vars → `bots: PersonaBotConfig[]`; legacy `DISCORD_BOT_TOKEN` maps to `DISCORD_DEFAULT_PERSONA` (default `implementor`); per-bot `DISCORD_ALLOWED_USERS_<ID>`/`DISCORD_ALLOWED_CHANNELS_<ID>` overrides; validate persona ids against DB; refuse empty user allowlists.
- [ ] `scripts/pipe.ts`: one `(DiscordChannel, AgentLoop)` per bot; graceful multi-client shutdown.
- [ ] `session-store.ts#getOrCreateRun(channel, externalId, personaId)`: look up `user_id` via `channel_identities`; create via `runs.create({goal: "<chat>", personaId, userId, runtime: "server", cwdStrategy: "none", toolsProfile: persona.toolsProfile, backend: persona.backend})`.
- [ ] `/link <token>` (DM only): verify via `lib/api-tokens.ts`, upsert `channel_identities`, confirm; `/whoami` reports persona + linked user.
- [ ] Tests: config discovery/legacy mapping, two bots isolated conversations in same channel, link flow, unlinked-user behavior unchanged.

## Milestone 5 — Orchestration + progress relay

- [ ] Seed `lib/personas/concierge.ts`: end-user-facing prompt, `toolsProfile: "orchestrator,spawn"`, `backend: "pi"`, generous `budgetMaxTurns`; register in `index.ts` / `seed-personas.ts`.
- [ ] `lib/pipe/relay.ts`: subscribe to `runs.subscribe` for child runs whose `parentRunId` maps (via `channel_threads`) to a pipe-owned persona run; post breadcrumbs (started / PR opened / failed / done) using `render.ts` formatting; dedupe per status transition.
- [ ] Verify inbox-driven turns (`child.result`, CI events) stream to the Discord thread through the existing draft/edit path.
- [ ] Long-thread guard: turn-count cap with `/new` nudge message.
- [ ] Tests: relay mapping + dedupe, breadcrumb formatting.

## Milestone 6 — Docs & polish

- [ ] `.env.example`: multi-bot token pattern, per-persona allowlists, `DISCORD_DEFAULT_PERSONA`.
- [ ] README/docs: "Persona bots on Discord" section — creating a Discord app per persona, required intents (`MessageContent` privileged, `Partials.Channel` for DMs), `/link` flow, security posture (no shell on server runtime).
- [ ] Update `SCHEMA.md` for the new tables/columns.
