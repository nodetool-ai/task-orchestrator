-- Generation-fenced worker process identity. Existing channels are generation 1.
ALTER TABLE "runner_instances"
  ADD COLUMN IF NOT EXISTS "worker_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "runner_instances"
  ADD COLUMN IF NOT EXISTS "generation_state" text DEFAULT 'stopped' NOT NULL;
--> statement-breakpoint
ALTER TABLE "runner_instances"
  ADD COLUMN IF NOT EXISTS "provider_operation_id" uuid;
--> statement-breakpoint
ALTER TABLE "runner_instances"
  ADD COLUMN IF NOT EXISTS "provider_service_name" text;
--> statement-breakpoint
ALTER TABLE "runner_instances"
  DROP CONSTRAINT IF EXISTS "runner_instances_generation_state_check";
--> statement-breakpoint
ALTER TABLE "runner_instances"
  ADD CONSTRAINT "runner_instances_generation_state_check"
  CHECK ("generation_state" IN ('allocating', 'booting', 'connecting', 'active', 'stopping', 'stopped', 'failed'));
--> statement-breakpoint
ALTER TABLE "worker_channel_commands"
  ADD COLUMN IF NOT EXISTS "worker_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "worker_channel_receipts"
  ADD COLUMN IF NOT EXISTS "worker_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "worker_channel_commands"
  DROP CONSTRAINT IF EXISTS "worker_channel_commands_generation_check";
--> statement-breakpoint
ALTER TABLE "worker_channel_commands"
  ADD CONSTRAINT "worker_channel_commands_generation_check"
  CHECK ("worker_generation" > 0);
--> statement-breakpoint
ALTER TABLE "worker_channel_receipts"
  DROP CONSTRAINT IF EXISTS "worker_channel_receipts_generation_check";
--> statement-breakpoint
ALTER TABLE "worker_channel_receipts"
  ADD CONSTRAINT "worker_channel_receipts_generation_check"
  CHECK ("worker_generation" > 0);
--> statement-breakpoint
DROP INDEX IF EXISTS "worker_channel_commands_run_instance_epoch_seq_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worker_channel_commands_run_generation_instance_epoch_seq_uniq"
  ON "worker_channel_commands" ("run_id", "worker_generation", "instance_id", "controller_epoch", "seq");
--> statement-breakpoint
DROP INDEX IF EXISTS "worker_channel_receipts_run_instance_worker_seq_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worker_channel_receipts_run_generation_instance_worker_seq_uniq"
  ON "worker_channel_receipts" ("run_id", "worker_generation", "instance_id", "worker_seq");
--> statement-breakpoint
DROP INDEX IF EXISTS "worker_channel_commands_run_instance_state_seq_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_channel_commands_run_generation_instance_state_seq_idx"
  ON "worker_channel_commands" ("run_id", "worker_generation", "instance_id", "state", "seq");
--> statement-breakpoint
DROP INDEX IF EXISTS "worker_channel_receipts_run_instance_worker_seq_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_channel_receipts_run_generation_instance_worker_seq_idx"
  ON "worker_channel_receipts" ("run_id", "worker_generation", "instance_id", "worker_seq");
