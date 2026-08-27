# Deploying the control plane on Fly.io

Fly.io can host the Task Orchestrator control plane: the dashboard, API, and
Postgres connection. It is not a runner provider. Configure agent execution
with `TASK_ORCH_RUNNER=sprites` or `local`; `TASK_ORCH_RUNNER=fly` fails at boot.

`fly.toml` remains the control-plane deployment manifest. It keeps one web
machine running because the control plane owns the pending-run pump and worker
reconciliation. Use the normal Fly deployment flow, supply `DATABASE_URL` and
the application secrets, and set `SPRITES_TOKEN` when using Sprites.
