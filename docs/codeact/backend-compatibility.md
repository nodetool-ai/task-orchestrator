# CodeAct backend compatibility

Claude and Codex runs expose the same two backend-neutral tools after extension
collection:

- `codeact_catalog({ query?, names? })` searches or describes only the direct
  tools mounted by the run's profile.
- `codeact_execute({ code, title? })` runs an async JavaScript function body in
  a fresh QuickJS-NG sandbox. The guest receives `app`, `tools`, `catalog`,
  `output`, and bounded `console` globals.

The adapters add this pair without replacing the collected direct tools.
Claude continues to use the `claude_code` preset (including Read, Write, Edit,
Bash, Grep, and Glob), and Codex continues to use its native shell and patch
tools under the configured sandbox. CodeAct is therefore the batching surface
for application operations, not a replacement for interactive coding tools.

## Policy and result compatibility

The catalogue is built after profile resolution, so an unmounted tool has no
`app.*` method or `tools.*` alias. Every subcall is schema-validated, passed
through the existing canonical interceptor chain, and then executed through the
same neutral tool callback used by a direct provider tool call. In dispatched
workers that callback is the worker channel; CodeAct never falls back to direct
database access. Host-generated execution and subcall IDs are used throughout.

Operation failures cross the worker-thread boundary with `code`, `message`,
`operationId`, `retryable`, and safe `details` fields. A failed sandbox is an
errored provider tool result rather than an MCP transport failure. Explicit
`output.image(...)` values in the normal `{ type: "image", data, mimeType }`
shape become native multimodal content blocks; artifact handles and other
structured values stay in the JSON execution summary.

The turn's `AbortSignal` terminates its CodeAct worker thread. Completed
subcalls remain completed, running calls become cancelled or unknown according
to the execution receipt, and late callbacks are dropped. Successful terminal
or parking operations (`report_result`, `raise`, `ask_parent`, and
`timer__sleep`) close further dispatch even if guest code catches the resulting
error.

## Discovery and interrupted executions

Catalogue query/name filters are applied to the complete authorized registry
before entry and byte limits. Guest `catalog.search` and `catalog.describe`
resolve against current host policy, so operations omitted from the initial
catalogue remain discoverable. Responses remain bounded.

Guest errors retain their name, message, and bounded stack in the durable
receipt, model response, and transcript. Deadline and cancellation responses
also include a reason.

The server and pipe reconcile interrupted CodeAct executions at startup; the
pending-run pump also retries reconciliation. Each new persisted execution
holds a PostgreSQL advisory transaction lock from before its initial receipt
through its final write. Ownership uses a separate pool of up to four
connections per process, leaving the ordinary query pool available for host
operations. Recovery skips locked executions, including those in other live
processes. For an unlocked running execution, it loads the independently
persisted subcalls, preserves completed outcomes, and atomically marks remaining
running work and the execution `unknown`. Recovery never replays guest source.

## Resume and unsupported behavior

Claude session IDs and Codex thread IDs remain the only conversation-persistence
mechanisms. The existing prompt transforms, ambient skills, event mapping,
usage accounting, retry rules, and lifecycle hooks are unchanged. CodeAct tools
are reconstructed on every turn, including resume, while each JavaScript VM is
fresh: guest globals, promises, and object handles are intentionally not
resumable. Persist durable state through application operations or artifact
handles, then submit new source after resume.

Neither Claude nor Codex supports `contextSource: "postgres"`; that lightweight
server-runtime loop is Pi-only. Both adapters reject the unsupported mode before
starting an SDK session. The tested compatibility path is to select the Pi
backend for server-runtime/postgres conversations, or keep Claude/Codex on their
normal SDK-session path. Codex also cannot route its built-in shell and patch
calls through neutral interceptors; its safe compatibility path remains the
existing scrubbed child environment plus Codex OS sandbox. MCP and CodeAct
application calls do run the canonical interceptors normally.
