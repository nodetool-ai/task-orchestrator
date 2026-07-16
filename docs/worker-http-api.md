# Worker HTTP + SSE protocol — REMOVED

**This protocol no longer exists.** As of the WebSocket migration (plan section
18, landed 2026-07), the worker HTTP + SSE transport, the `/api/worker/*`
routes, worker API tokens, and the `TASK_ORCH_WORKER_TRANSPORT` flag have all
been deleted. Workers never make an outbound request to the control plane and
never hold `DATABASE_URL`.

The worker protocol is now **WebSocket-only**: the control plane dials each
dispatched worker's private listener and pushes the run over the channel.

See:

- [docs/worker-websocket-protocol.md](worker-websocket-protocol.md) — the
  normative protocol design.
- [docs/worker-websocket-implementation-plan.md](worker-websocket-implementation-plan.md)
  — the migration plan and history.
