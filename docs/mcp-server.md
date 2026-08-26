# MCP server (production setup)

The orchestrator exposes its full tool surface as a **remote MCP server** at
`POST /api/mcp` — the same registry the in-process agent runtime uses, so a
Claude Code session on your laptop drives the same plans, tasks, and runs as
the dashboard.

- **Endpoint:** `https://<your-host>/api/mcp`
- **Transport:** Streamable HTTP, JSON-RPC 2.0, one JSON response per request
  (no SSE — nothing here runs long enough to need streaming)
- **Protocol version:** `2024-11-05`
- **Auth:** `Authorization: Bearer tot_…` (see [Authentication](#authentication))
- **Implementation:** [`app/api/mcp/route.ts`](../app/api/mcp/route.ts),
  tools from [`lib/orchestrator-tools.ts`](../lib/orchestrator-tools.ts)

## Quick start

1. Sign in to the deployment and open **Settings → API tokens**
   (`/settings?tab=tokens`).
2. Name a token after the client that will hold it (`claude-desktop`,
   `laptop-cli`, …) and press **Generate**. The secret is shown **once**.
3. In the **Connect a client** panel, pick your client. The snippet already
   contains this deployment's origin and the fresh token. Copy it, or use
   **Install in Cursor / VS Code** (deep link) or **Download .mcp.json**.
4. Press **Test connection**. It performs a real `tools/list` against
   `/api/mcp` with that token and reports how many tools answered.

Everything in that panel is generated from
[`lib/mcp-clients.ts`](../lib/mcp-clients.ts), so the UI, the downloaded
`.mcp.json`, and the snippets below cannot drift apart.

## Authentication

### Token model

Tokens are `tot_` + 43 base64url characters (32 random bytes). The plaintext
is returned exactly once, at creation, and is never persisted:
`api_tokens` stores a bcrypt hash (cost 10) plus the first 8 plaintext
characters as a lookup prefix. Verification hits the prefix index, then
bcrypt-compares the candidates; a miss burns one dummy compare so timing
stays roughly flat. See [`lib/api-tokens.ts`](../lib/api-tokens.ts).

| Property | Behaviour |
| --- | --- |
| Scope | The token acts as its owning user. There are no per-token scopes — a token can call every tool in the registry. |
| Author trail | Mutations are attributed to the owner's email, so notes and transitions read the same as UI edits. |
| Expiry | None. Tokens live until revoked. |
| Revocation | Immediate: `revoked_at` is set and the next call 401s. |
| Audit | `last_used_at` is bumped on every successful verification, and is shown per token in the UI. |

Practical consequences for a production deployment:

- **Issue one token per client, not per person.** Revoking a laptop then
  costs nothing on your phone or CI.
- **Treat the token like a password.** Anyone holding it can create and
  transition tasks and start agent runs as its owner.
- **Rotate by overlap:** generate the replacement, reconfigure the client,
  confirm `last_used_at` moves on the new token, then revoke the old one.

### Why `/api/mcp` bypasses the session gate

[`middleware.ts`](../middleware.ts) gates every route behind an Auth.js
session, with `/api/mcp` explicitly exempted — MCP clients have no browser
session and must not be redirected to `/login`. Authentication for the
endpoint therefore lives entirely in the route handler. Two things follow:

- The endpoint is reachable without a cookie **by design**; its only
  defence is the bearer token. Do not put it behind a path-based allowlist
  that also strips `Authorization`.
- In local development the login gate is disabled
  (`NODE_ENV=development`, see [`lib/auth-mode.ts`](../lib/auth-mode.ts)),
  but `/api/mcp` still demands a valid token. A dev deployment needs a real
  token in the local database the same way production does.

### Diagnosing a 401

The endpoint answers with JSON that names the failure mode and links to the
token page:

```json
{
  "error": "Unauthorized",
  "reason": "missing_authorization_header",
  "hint": "Send `Authorization: Bearer tot_…`. Issue and revoke tokens in Settings → API tokens.",
  "tokens_url": "https://tasks.example.com/settings?tab=tokens"
}
```

| `reason` | What it means | Fix |
| --- | --- | --- |
| `missing_authorization_header` | No `Authorization` header arrived. | The client never sent one, or a proxy stripped it — see below. |
| `malformed_authorization_header` | Present but not `Bearer <token>`. | Check for a stray newline or quotes in the client config. |
| `invalid_or_revoked_token` | Well-formed but no live token matches. | Token was revoked, belongs to another deployment, or was truncated on paste. |

A `GET` on the endpoint returns `405` with the same setup facts in the body,
so pasting the URL into a browser tells you what to do next instead of
showing a bare "Method Not Allowed".

## Deployment requirements

The MCP server ships with the web app — there is no separate process, port,
or feature flag. What production does need:

1. **TLS.** Tokens travel in a header on every call. Terminate HTTPS in
   front of the app (Cloudflare Tunnel, Fly's edge, your own proxy) and
   never expose the origin port directly.
2. **`Authorization` passes through the proxy untouched.** This is the most
   common production failure: proxies that rewrite or drop the header make
   every call 401 with `missing_authorization_header`. Cloudflare Tunnel and
   Fly pass it by default; custom nginx configs often do not
   (`proxy_set_header Authorization $http_authorization;`).
3. **`NEXTAUTH_URL` set to the public origin**, plus `AUTH_TRUST_HOST=true`
   when a reverse proxy fronts the app. The Settings UI builds snippets from
   the browser's origin, so a wrong value here shows up as clients being
   configured against the internal host.
4. **A migrated database.** The `api_tokens` table comes from the standard
   Drizzle migrations (`npm run db:generate` / the deploy's migrate step).
   No extra setup.
5. **Node runtime.** The route is `runtime = "nodejs"` and
   `dynamic = "force-dynamic"` — bcrypt and the DB driver rule out the Edge
   runtime, and responses must never be cached.

Deployment guides: [Fly](fly-deployment.md) ·
[runners](runners/README.md).

### Operating notes

- **Cost of a call.** Verification runs bcrypt (cost 10, ~50–100 ms) on every
  request. That is deliberate, and fine at MCP call rates; do not put the
  endpoint behind a health-check loop.
- **No rate limiting is built in.** If the deployment is internet-facing, put
  your edge's rate limiter in front of `/api/mcp` to blunt token guessing —
  though guessing a 256-bit secret is not the realistic threat, and revocation
  is the real control.
- **Auditing.** `last_used_at` per token plus the owner's email on every
  mutation is the audit trail. A token that has not been used in months is a
  revocation candidate.
- **Blast radius.** Tools include `delete_task`, `delete_plan`, and
  `start_session` (which spends model budget). Hand tokens only to people who
  are allowed to do those things in the UI.

## Client configuration

Each snippet below is what the app generates; `<your-host>` is your public
origin and `tot_…` the token shown at creation.

**Claude Code**

```bash
claude mcp add --transport http \
  task-orchestrator \
  https://<your-host>/api/mcp \
  --header "Authorization: Bearer tot_…"
```

**Claude Desktop** (Settings → Developer → Edit Config), **Cursor**
(`~/.cursor/mcp.json`), or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "task-orchestrator": {
      "type": "http",
      "url": "https://<your-host>/api/mcp",
      "headers": { "Authorization": "Bearer tot_…" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`) uses a `servers` key instead of
`mcpServers`, with the same entry shape.

**Smoke test**

```bash
curl -sS https://<your-host>/api/mcp \
  -H "Authorization: Bearer tot_…" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A healthy deployment returns the full tool list; `initialize` returns
`serverInfo.name = "task-orchestrator"`.

## Tool surface

`tools/list` serves the orchestrator registry under bare names (no
`mcp__task_orch__` prefix — that prefix is added by the in-process agent
runtime, not by this endpoint), grouped as:

- **Repositories** — `list_repositories`, `get_repository`,
  `create_repository`, `update_repository`, `delete_repository`
- **Plans** — `list_plans`, `get_plan`, `create_plan`, `update_plan`,
  `transition_plan`, `delete_plan`, `add_plan_repository`,
  `remove_plan_repository`
- **Tasks** — `list_tasks`, `get_task`, `create_task`, `update_task`,
  `transition_task`, `set_task_pr`, `delete_task`
- **Notes & criteria** — `add_note`, `list_notes`, `list_criteria`,
  `add_criterion`, `check_criterion`, `uncheck_criterion`,
  `update_criterion`, `delete_criterion`
- **Attachments** — `list_attachments`, `get_attachment`, `add_attachment`,
  `delete_attachment`
- **Sessions** — `list_sessions`, `get_session`, `start_session`,
  `await_session`, `cancel_session`

Arguments are validated server-side against the same TypeBox schemas served
in `tools/list`, so a bad enum or wrong-typed field is rejected with
JSON-RPC `-32602` before it reaches the database.

Supported methods: `initialize`, `notifications/initialized` (202, no body),
`ping`, `tools/list`, `tools/call`. Anything else returns `-32601`.
