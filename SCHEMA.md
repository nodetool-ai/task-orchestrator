# DB schema & state machines

The DB lives at `data.db`. Schema is in [`db/schema.ts`](db/schema.ts); the
initial SQL is in [`db/migrations/0000_init.sql`](db/migrations/0000_init.sql).
Migrations run automatically the first time the DB is opened.

## Tables

```
plans                    one row per plan
  id          TEXT  PK         e.g. P-2026-05-11-task-system
  title       TEXT  NOT NULL
  state       TEXT  NOT NULL   see plan state machine
  owner       TEXT
  body        TEXT  default ''  free-form markdown
  tags        TEXT  default '[]'  JSON array
  created_at  INTEGER  ms epoch
  updated_at  INTEGER  ms epoch

tasks                    one row per task
  id          TEXT  PK         e.g. T-20260511-0001
  title       TEXT  NOT NULL
  state       TEXT  NOT NULL   see task state machine
  plan_id     TEXT  FK → plans.id ON DELETE CASCADE
  assignee    TEXT
  body        TEXT  default ''  free-form markdown
  estimate    TEXT
  tags        TEXT  default '[]'  JSON array
  branch      TEXT             canonical git branch (claude/<taskid>); reserved
                               when the first implement run is created and
                               shared by every later run on the task
  created_at, updated_at

task_dependencies        many-to-many
  task_id        TEXT  FK → tasks.id  ON DELETE CASCADE
  depends_on_id  TEXT  FK → tasks.id  ON DELETE CASCADE
  PRIMARY KEY (task_id, depends_on_id)

task_notes               append-only activity log
  id          INTEGER  AUTOINC PK
  task_id     TEXT     FK → tasks.id  ON DELETE CASCADE
  author      TEXT     NOT NULL
  body        TEXT     NOT NULL
  created_at  INTEGER  ms epoch

acceptance_criteria      checkable items per task
  id          INTEGER  AUTOINC PK
  task_id     TEXT     FK → tasks.id  ON DELETE CASCADE
  text        TEXT     NOT NULL
  done        INTEGER  boolean (0/1)
  position    INTEGER  ordering within task

attachments              images & artifacts on a plan or task
  id          INTEGER  AUTOINC PK
  plan_id     TEXT     FK → plans.id  ON DELETE CASCADE  (nullable)
  task_id     TEXT     FK → tasks.id  ON DELETE CASCADE  (nullable)
  filename    TEXT     NOT NULL
  mime_type   TEXT     NOT NULL
  kind        TEXT     NOT NULL   'image' (mime image/*) | 'artifact'
  size_bytes  INTEGER  NOT NULL   capped at 25 MiB (repo.MAX_ATTACHMENT_BYTES)
  content     BLOB     NOT NULL   the raw bytes, inline
  author      TEXT     NOT NULL
  created_at  INTEGER  ms epoch
  CHECK ((plan_id IS NOT NULL) <> (task_id IS NOT NULL))  -- exactly one owner

agent_sessions           one row per pi.dev SDK run on a task
  id              INTEGER  AUTOINC PK
  task_id         TEXT     FK → tasks.id ON DELETE CASCADE
  persona_id      TEXT     FK → personas.id ON DELETE SET NULL  default 'implementor'
  planning_stage  TEXT     gated `<plan>` flow stage (NULL = ordinary run): gathering → spec_review → building_plan → plan_review → committing → done
  status          TEXT     see session status machine
  model           TEXT     e.g. claude-sonnet-4-5
  branch          TEXT     the task's canonical branch (tasks.branch), e.g. claude/t-20260511-0001; taskless chat worktrees use claude/chat-<run>
  worktree_path   TEXT     absolute path to the git worktree
  pr_url          TEXT     filled in after gh pr create
  error           TEXT     populated on failure
  total_cost_usd  REAL     captured from SDK result.total_cost_usd (populated only on legacy pre-pi rows; not enforced post-cutover).
  input_tokens    INTEGER  captured from SDK result.usage
  output_tokens   INTEGER  captured from SDK result.usage
  sdk_session_id  TEXT     pi.dev: absolute path to the JSONL session file under `<cwd>/.pi/sessions/`. Used to resume.
  resume_of       INTEGER  prior agent_sessions.id this run continues
  runtime         TEXT     NOT NULL default 'worker' — WHERE this run's turns execute: 'worker' (a detached process/container/Machine) | 'server' (in the control-plane/pipe process). See below.
  user_id         INTEGER  FK → users.id ON DELETE SET NULL — the human this run belongs to (set from channel_identities for messaging runs)
  started_at      INTEGER  ms epoch
  completed_at    INTEGER  ms epoch, nullable

agent_events             append-only log per session (replay + SSE source)
  id          INTEGER  AUTOINC PK
  session_id  INTEGER  FK → agent_sessions.id ON DELETE CASCADE
  type        TEXT     status | shell | shell_out | stderr | agent
                       | prompt | worktree | pr | warning
  payload     TEXT     JSON
  created_at  INTEGER  ms epoch

agent_messages           persisted assistant/tool/user message blocks
  id          INTEGER  AUTOINC PK
  run_id      INTEGER  FK → agent_sessions.id ON DELETE CASCADE
  role        TEXT     'user' | 'agent' | 'tool' | 'system'
  content     TEXT     JSON array of content blocks
  created_at  INTEGER  ms epoch

For chat, `agent_messages` is the UI/streaming projection of the conversation.

Nearly every run — chats, plan executors (goal=`<execute>`), implement, and
review — executes in an out-of-process **worker** (a detached local process,
Docker container, or Fly/Box Machine). The worker drives its model turns over the
WebSocket channel and resumes conversation context from its backend's SDK
session, so no run holds the control-plane event loop or its heap.

**`runtime = 'server'`** is the one exception, and it exists for persona
conversations on messaging surfaces (`goal = '<chat>'`, mapped in
`channel_threads`). Such a run's turns execute *inside* the process that owns the
conversation — the pipe — with no container, no worktree and no SDK session file.
The rules, all enforced in code:

- **Internal callers only.** `runtime` is not exposed in the `POST /api/runs`
  request schema; it is set by `runs.create` callers inside the process.
- **Server-safe tools only.** The turns run next to `DATABASE_URL` and the
  orchestrator's own checkout, so the tool surface is the sandbox:
  `runs.create` rejects a `'server'` run whose profile resolves any shell,
  filesystem or repo-write capability (`serverSafe` in `lib/profiles.ts`). The
  pipe additionally checks this once at boot, per bot, and refuses to start.
- **pi backend only.** A server run drives the postgres-turn loop, which the
  claude backend cannot; `runOneTurn` rejects the combination.
- **Excluded from dispatch.** The pending-run pump and reconciliation in
  `lib/run-dispatch.ts` skip `runtime = 'server'` rows — nothing may dispatch
  them to a worker — and wakes for a MAPPED conversation are deferred to the
  pipe process, which is where the chat draft lives.

A legacy `'server'` value also survives on pre-cutover rows from the retired
in-process lightweight loop; those are inert.

personas                 persona registry (seeded from lib/personas/*.ts)
  id                  TEXT  PK              e.g. 'reviewer', 'implementor'
  name                TEXT  NOT NULL        display name
  description         TEXT
  system_prompt       TEXT  NOT NULL
  model_provider      TEXT  NOT NULL        default provider for new runs
  model_id            TEXT  NOT NULL        default model for new runs
  thinking_level      TEXT                  'low' | 'medium' | 'high' | NULL
  tools_profile       TEXT  NOT NULL        composed profile keys
  skill_paths         TEXT  NOT NULL        JSON array of repo-relative paths
  budget_max_turns    INTEGER
  budget_max_seconds  INTEGER
  created_at, updated_at

persona_memories         per-persona cross-session notes
  id          INTEGER  AUTOINC PK
  persona_id  TEXT     FK → personas.id  ON DELETE CASCADE
  scope       TEXT     NOT NULL              'global' | <repo_id> | <task_id>
  body        TEXT     NOT NULL DEFAULT ''   markdown bullets
  updated_at  INTEGER  ms epoch
  UNIQUE(persona_id, scope)

memories                 shared long-term memory for chats and agents
  id                 INTEGER  AUTOINC PK
  scope              TEXT     NOT NULL       'global' | 'repo' | 'task' | 'persona' | 'user'
  scope_key          TEXT                    NULL for global; repo_id / task_id /
                                             persona_id / users.id otherwise
  body               TEXT     NOT NULL
  keywords           TEXT     NOT NULL       JSON array used for BM25 search
  author             TEXT     NOT NULL
  created_by_run_id  INTEGER  FK → agent_runs.id ON DELETE SET NULL
  created_at         INTEGER  ms epoch
  updated_at         INTEGER  ms epoch

The memory tools search scoped candidate rows with application-level BM25 over
`body` plus boosted `keywords`. Agents and chats can write memories with
`memory_remember`, search them with `memory_search`, and remove stale entries
with `memory_forget`.

The scope set is `global | repo | task | persona | user`. `persona` holds a
persona's own working style (keyed by `personas.id`) and `user` holds durable
facts about a person (keyed by `users.id`, addressable only once that person has
linked a channel account — see `channel_identities`). Visibility is per scope
key, so two personas — or two users — never read each other's rows. A turn mounts
its visible scopes ambiently, with per-scope-group recency caps so repo memories
cannot evict user/persona ones.

channel_threads          a messaging conversation ↔ the run that backs it
  id           INTEGER  AUTOINC PK
  channel      TEXT     NOT NULL   transport name, e.g. 'discord'
  external_id  TEXT     NOT NULL   channel-native conversation id (thread/DM/channel)
  persona_id   TEXT     NOT NULL  FK → personas.id ON DELETE CASCADE  default 'implementor'
  user_id      INTEGER  FK → users.id ON DELETE SET NULL — the thread's owner, backfilled on /link
  run_id       INTEGER  NOT NULL  FK → agent_runs.id ON DELETE CASCADE  (the '<chat>' server-runtime run)
  created_at   TIMESTAMPTZ
  UNIQUE (channel, external_id, persona_id)

channel_identities       an external chat account ↔ a local user
  id                INTEGER  AUTOINC PK
  channel           TEXT     NOT NULL   e.g. 'discord'
  external_user_id  TEXT     NOT NULL   the channel-native account id (a Discord snowflake)
  user_id           INTEGER  NOT NULL  FK → users.id ON DELETE CASCADE
  label             TEXT               display handle at link time, for operator UIs
  created_at        TIMESTAMPTZ
  UNIQUE (channel, external_user_id)

`persona_id` is NOT NULL (existing rows were backfilled to `'implementor'`): the
3-tuple unique index is what lets N persona bots each hold their own
conversation in one Discord channel, and a nullable column would make that key
ambiguous. `user_id` on both the thread and its run stays nullable —
attribution is opt-in and arrives later, via the one-time `/link <api-token>` DM
(`lib/api-tokens.ts` verifies and *consumes* the token; only the association is
stored, never the token itself). Linking upgrades attribution; it does not gate
access — the per-bot allowlist does that.

codex_credentials       The Codex (ChatGPT) OAuth credential. Singleton row.
  id                 INTEGER  PK, pinned to 1 by CHECK
  access_token       TEXT     NOT NULL
  refresh_token      TEXT
  id_token           TEXT
  account_id         TEXT     chatgpt_account_id claim (or the OIDC subject)
  expires_at         TIMESTAMPTZ  decoded from the access token's exp claim
  updated_at         TIMESTAMPTZ

codex_login_attempts    Device-code logins in flight (PKCE verifiers).
  state              TEXT     PK, the OAuth state echoed back on the callback
  verifier           TEXT     NOT NULL
  created_at         TIMESTAMPTZ  swept after 15 minutes

Written by the device-code login in Settings → Codex (lib/codex-oauth-store.ts).
This is the control plane's only source for the Codex bearer — ~/.codex/auth.json
is not read, and CODEX_ACCESS_TOKEN is not a deploy secret. Dispatch resolves and
refreshes the token here, then forwards it to workers as CODEX_ACCESS_TOKEN,
since workers hold no database credentials.
```

## ID format

- **Plans**: `P-YYYY-MM-DD-slug` (slug is auto-derived from the title on create)
- **Tasks**: `T-YYYYMMDD-NNNN` (NNNN is a per-day counter, assigned by the repo)

You can override the ID on creation; the API's zod validator enforces
the format.

## State machines

### Plans

```
draft ──▶ proposed ──▶ accepted ──▶ done
  │           │             │
  └───────────┴─────────────┴──▶ cancelled
```

A plan is "done" when every non-cancelled task is `done`.
The transition is **not** automatic — set it explicitly.

### Tasks

```
todo ──▶ in_progress ──▶ review ──▶ done
  │           │             │
  │           └─▶ blocked ──┘
  │           │
  └───────────┴─▶ cancelled
```

Allowed transitions (enforced by `repo.transitionTask`):

| From          | Allowed `→`                                 |
|---------------|---------------------------------------------|
| `todo`        | `in_progress`, `cancelled`                  |
| `in_progress` | `review`, `done`, `blocked`, `cancelled`    |
| `review`      | `in_progress`, `done`, `cancelled`          |
| `blocked`     | `in_progress`, `cancelled`                  |
| `done`        | (terminal — create a new task to reopen)    |
| `cancelled`   | (terminal)                                  |

Going to `in_progress` requires an `assignee`.
Going to `done` requires all acceptance criteria to be checked.

### Agent sessions

```
pending ─▶ preparing ─▶ running ─▶ pushing ─▶ opening_pr ─▶ completed
                │           │           │           │
                └───────────┴───────────┴───────────┴─▶ failed
                                                    │
                                                    └─▶ cancelled
```

A session never moves backwards. Terminal states (`completed`, `failed`,
`cancelled`) close the SSE stream and drop the in-process bus.

## REST surface

See [README.md](README.md#rest). Each route is a thin wrapper around a
function in [`lib/repo.ts`](lib/repo.ts); the CLI calls the same functions
directly.
