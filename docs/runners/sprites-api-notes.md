# Sprites API notes — verified against https://sprites.dev/api (2026-08-26)

This file records the exact request/response shapes the `lib/runner/sprites-client.ts` relies on, with links to the doc page that defines each. See `docs/sprites-migration-design.md §2` for the higher-level mapping.

## Sprites CRUD

### Create sprite — `POST /sprites` — https://sprites.dev/api/sprites#create
Request (JSON):
```json
{
  "name": "my-sprite",
  "url_settings": { "auth": "sprite" }
}
```
- `name*` string, unique per org
- `url_settings.auth?` "sprite" | "public" (default "sprite")

Response (201, JSON):
```json
{
  "id": "01234567-89ab-cdef-0123-456789abcdef",
  "name": "my-sprite",
  "status": "cold",
  "url": "https://my-sprite-xxx.sprites.app",
  "url_settings": { "auth": "sprite" },
  "organization": "my-org",
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T14:22:00Z",
  "last_started_at": "2024-01-15T14:20:00Z",
  "last_active_at": "2024-01-15T14:22:00Z"
}
```
- `status*` "cold" | "warm" | "running" — the only documented enum values. No `creating`/`destroyed` in the create response; `warm` appears in the list/get examples elsewhere.
- Timestamps are ISO 8601 `created_at`, `updated_at`.

Client uses: `POST /sprites` with `{ name, url_settings }`, parses `name`, `status`, `created_at`, `url`, `region` (region not documented, but returned in some examples as `organization`).

### Get sprite — `GET /sprites/{name}` — https://sprites.dev/api/sprites#get
Response same shape as create. 404 → null (client maps 404 to null).

### List sprites — `GET /sprites` — https://sprites.dev/api/sprites#list
Query params: `prefix?`, `max_results?` (1-50, default 50), `continuation_token?`
Response (200):
```json
{
  "sprites": [
    { "name": "my-dev-sprite", "org_slug": "my-org", "updated_at": "2024-01-15T14:22:00Z" }
  ],
  "has_more": true,
  "next_continuation_token": "eyJsYXN0IjoibXktZGV2LXNwcml0ZSJ9"
}
```
- Pagination fields are `has_more` (bool) and `next_continuation_token` (string), not `continuation_token`. The request token param is `continuation_token`.
- List entries in the docs example only contain `name`, `org_slug`, `updated_at` — no `status` or `created_at`. Other examples (Go) show fuller entries with `status`, `created_at`. The client must handle both: it maps whatever is present, but prefers `status` and `created_at` when available.

Client uses: `GET /sprites?prefix=&max_results=&continuation_token=` and maps `sprites` array and `next_continuation_token` / `has_more`.

### Destroy sprite — `DELETE /sprites/{name}` — https://sprites.dev/api/sprites#destroy
Response 204 or 404 (client treats 404 as no-throw).

## Exec

### Execute command (WSS) — `WSS /sprites/{name}/exec` — https://sprites.dev/api/sprites/exec#execute-command
Not used by the current client (exec over WSS is the primary exec path, but the client uses the simpler POST variant).

### Execute command (POST) — `POST /sprites/{name}/exec` — https://sprites.dev/api/sprites/exec#execute-command-post
Query params: `cmd*` (repeatable), `path?`, `stdin?`, `env?` (repeatable `KEY=VALUE`), `dir?`
Docs show **no request body table** for the POST variant — it is query-param driven. The example is `curl -X POST /sprites/{name}/exec` with no body.

Current client sends JSON `{ cmd, timeout_ms }`. `timeout_ms` is **not documented** on the POST page (WSS page has `max_run_after_disconnect` as a duration). No field named `timeout_ms` appears in the fetched docs.

Response body (docs say `application/json` but no schema shown). Client currently expects `{ exit_code, stdout, stderr }` or similar.

**Unverified:** whether `timeout_ms` is accepted, and what the JSON response shape actually is for the POST variant. The client should be considered speculative until measured with a real token (see "Still unverified").

## Services — https://sprites.dev/api/sprites/services

### Create service — `PUT /sprites/{name}/services/{serviceName}` — https://sprites.dev/api/sprites/services#create-service
Query: `duration?` (duration)
Request (JSON):
```json
{
  "cmd": "python",
  "args": ["-m", "http.server", "8000"],
  "env": { "FOO": "bar" },
  "dir": "/home/user/worker",
  "needs": ["postgres"],
  "http_port": 8000
}
```
- `cmd*` string, `args*` string[], `env?` map, `dir?` string, `needs*` string[], `http_port?` number
- Note: `env` is documented as `map` (object), `needs` as string array, `dir` as string, `http_port` as number. No `command` vs `cmd` alias.

Response (200, JSON): same shape plus `state` object `{ status, pid, started_at, error }`.

Current client sends `{ cmd, args, env, dir, needs, http_port }` — matches docs.

### Start service — `POST /sprites/{name}/services/{serviceName}/start` — https://sprites.dev/api/sprites/services#start-service
Request: no body. Query `duration?`.
Response: `application/x-ndjson` streaming `type: "started"|"stdout"|"stderr"|"complete"` events. Client currently treats it as empty 200 (no streaming handling) — okay for fire-and-forget.

### Stop / Restart — `POST .../stop`, `POST .../restart` — similar NDJSON, no body needed.

### Get service logs — `GET /sprites/{name}/services/{serviceName}/logs` — https://sprites.dev/api/sprites/services#get-service-logs
Query `lines?`, `duration?`. Response `application/x-ndjson`. Client currently does `GET .../logs` and expects JSON `{ logs }` or string — not matching NDJSON. Tightening this is deferred until measured.

## Checkpoints — https://sprites.dev/api/sprites/checkpoints

### Create checkpoint — `POST /sprites/{name}/checkpoint` — https://sprites.dev/api/sprites/checkpoints#create-checkpoint
Request (JSON): `{ "comment": "Before deploying v2.0" }` — only `comment?` string.
Response: `application/x-ndjson` streaming `type: "info"|"complete"` events, not JSON. Client currently expects JSON `{ checkpoint }` — speculative.

### List checkpoints — `GET /sprites/{name}/checkpoints` — https://sprites.dev/api/sprites/checkpoints#list-checkpoints
Response (200, JSON array):
```json
[
  { "id": "v7", "create_time": "2026-01-05T10:30:00Z", "source_id": "v6", "comment": "Before database migration", "health": "" }
]
```
- Fields: `id*`, `create_time*` (ISO 8601), `source_id?`, `comment?`, `health?`
- Note: `create_time` not `created_at`, `id` not `checkpoint_id`.

Current client handles both array and `checkpoints` wrapper — should be narrowed to array.

### Get checkpoint — `GET /sprites/{name}/checkpoints/{checkpointId}` — same single object shape.

### Restore checkpoint — `POST /sprites/{name}/checkpoints/{checkpointId}/restore` — https://sprites.dev/api/sprites/checkpoints#restore-checkpoint
Request: no body. Response: NDJSON streaming.

## Network policy — https://sprites.dev/api/sprites/policies

### Get network policy — `GET /sprites/{name}/policy/network` — https://sprites.dev/api/sprites/policies#get-network-policy
Response (200):
```json
{
  "rules": [
    { "domain": "github.com", "action": "allow" },
    { "domain": "*.npmjs.org", "action": "allow" },
    { "domain": "*", "action": "deny" }
  ]
}
```
- `rules*` array of `{ domain?, action? ("allow"|"deny"), include? }`
- `include` is a preset name.

### Set network policy — `POST /sprites/{name}/policy/network` — https://sprites.dev/api/sprites/policies#set-network-policy
Request (JSON): same shape:
```json
{
  "rules": [
    { "action": "allow", "domain": "github.com" },
    { "action": "allow", "domain": "*.npmjs.org" }
  ]
}
```
- Current client previously sent `{ allow: [...] }` with `as unknown` cast — not matching docs. Fixed to `rules` array with `allow`/`deny`.

## Resources policy — https://sprites.dev/api/sprites/policies#set-resources-policy
Docs show no request body schema (empty). Client treats it as opaque `unknown`.

## Proxy — `WSS /sprites/{name}/proxy` — https://sprites.dev/api/sprites/proxy#tcp-proxy
Handshake: client sends `{"host": "localhost", "port": 8080}`, server replies `{"status": "connected", "target": "localhost:8080"}`, then raw TCP relay.

Client uses `wss://api.sprites.dev/v1/sprites/{name}/proxy` with `Authorization: Bearer` and the JSON handshake.

## Filesystem — https://sprites.dev/api/sprites/filesystem
Not used by current provider.

---

## Still unverified

- **Exec POST body vs query:** docs show query-param `cmd` for POST, no body table. Whether a JSON body `{ cmd, timeout_ms }` is honored is unverified. Measured behavior needed with real token; the feasibility script (`scripts/sprites-feasibility.ts`) will exercise this.
- **Exec POST response:** docs say `application/json` but show no schema. Whether it returns `{ exit_code, stdout, stderr }` with `exit_code` (snake) vs `exitCode` (camel) is unverified. Client currently handles `exit_code` only after tightening.
- **Checkpoint create/restore streaming:** docs show NDJSON progress, not JSON. Our client's `checkpoint()` expecting a JSON checkpoint object is unverified; may need to parse NDJSON and extract final checkpoint id from the stream.
- **Service logs:** docs show NDJSON, client currently expects JSON `{ logs }`. Unverified until measured.
- **List sprites full shape:** docs example for list shows minimal fields (`name`, `org_slug`, `updated_at`), but the Go example shows richer entries with `status`, `created_at`, `url`, etc. Which fields are present when listing with prefix filter is unverified; sweep currently only needs `name` and `createdAt` (from `created_at`), but `status` is needed for lifecycle.
- **Sprite status enum completeness:** docs list `cold` | `warm` | `running` as the create response enum, but the list example shows `cold` and the provider maps `warm`/`cold`/`running` plus `hibernated`/`destroyed` aliases. Whether `warm` is actually returned or `hibernated` appears is unverified.
- **Network policy `include` presets:** docs list `include` as a string field alongside `domain`/`action`, but the preset names are not enumerated. Whether the allowlist should use `include` vs explicit domains is unverified.
- **Resources policy body:** docs show no schema; the shape is opaque until measured.
