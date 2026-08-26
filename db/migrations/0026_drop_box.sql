-- The Box (ascii.dev) runner integration is removed: TASK_ORCH_RUNNER=box no
-- longer exists, so the Box-specific restoration/checkpoint metadata on
-- runner_instances and the Box artifact column on environments are dead
-- weight. Dropping them is destructive to historical Box rows by design —
-- there is no code path left that could read or resume them.
DROP INDEX IF EXISTS "runner_instances_box_id_idx";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "box_id";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "box_template_id";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "box_source_id";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "snapshot_id";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "snapshot_completed_at";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "checkpoint_requested_at";
ALTER TABLE "runner_instances" DROP COLUMN IF EXISTS "last_checkpoint_at";
ALTER TABLE "environments" DROP COLUMN IF EXISTS "box_id";
