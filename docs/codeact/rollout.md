# CodeAct rollout and rollback

Each new run stores `tool_calling_mode` as `direct` or `codeact`. Resumes use
that recorded value, so a retry never replays a script through another tool
surface.

The default after cutover is CodeAct. For a controlled cohort, set
`TASK_ORCH_CODEACT_ROLLOUT_PERCENT` to a value from 0 to 100; assignment is
deterministic from the run's stable creation inputs. To roll back new runs,
set `TASK_ORCH_TOOL_CALLING_MODE=direct` and restart the control plane. This
does not rewrite existing rows or replay failed CodeAct source.

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
