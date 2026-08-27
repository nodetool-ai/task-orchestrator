# Workers and runners

Task Orchestrator has two runner providers:

- `local` (the default): a detached process or Docker worker on the control-plane host.
- `sprites`: one isolated Sprite per run.

`TASK_ORCH_RUNNER=fly` is retired and fails at startup. Fly.io may still host the
control plane; it is not a runner provider.

Every provider implements `create`, `stop`, and `sweep`. `sweep` reconciles
runner state and, for local Docker workers, starts the idempotent Docker event
monitor. The pending-run pump invokes `sweep` periodically.

See [Local / Docker](docker-local.md) and [Sprites](sprites.md).
