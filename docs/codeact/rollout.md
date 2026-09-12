# CodeAct rollout and rollback

CodeAct is always enabled for every backend, including resumed runs carrying a
legacy `direct` value. New runs record `tool_calling_mode = codeact`; old rows
remain readable, but their value does not select a different tool surface.
`TASK_ORCH_TOOL_CALLING_MODE` and `TASK_ORCH_CODEACT_ROLLOUT_PERCENT` no longer
disable CodeAct.

Operations covered by the run's CodeAct SDK are exposed only through
`codeact_catalog` and `codeact_execute`. Registered handlers, including lifecycle operations,
remain private implementations of the SDK. Per-operation validation and
policy checks still run inside CodeAct. Pi retains control-plane execution and
durable receipts; helpers absent from its authorized SDK remain native.
Harness-provided coding tools remain
subject to the existing native-tool policy. Remote MCP exposes the same two
outer tools and rejects direct application-tool calls.

Interrupted executions are reconciled from `codeact_executions` and
`codeact_subcalls`. Completed, failed, cancelled, and unknown subcalls remain
visible; unknown external effects must be reconciled before a new mutation is
submitted.

## Gate evidence

The release gate is the focused CodeAct suite, typecheck, application build,
worker builds, and the existing worker websocket/bundle-guard suites. The
benchmark cohort must use fixed samples and compare task triage, plan/criteria,
schedule, CI investigation, memory, image inspection, and coding workflows
against the direct baseline. Cutover targets are 80% eligible CodeAct traffic,
30% fewer tool-context tokens, no more than 10% p95 latency regression, and
no worse completion quality; any authorization or recovery failure blocks it.
