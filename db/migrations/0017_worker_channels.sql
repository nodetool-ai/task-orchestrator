-- Durable control-plane identity and connection state for a worker channel.
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "channel_instance_id" text;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "channel_endpoint" text;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "controller_epoch" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "controller_id" text;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "controller_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "channel_connected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "channel_last_seen_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_instances_controller_lease_expires_at_idx"
  ON "runner_instances" USING btree ("controller_lease_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runner_instances_channel_instance_id_idx"
  ON "runner_instances" USING btree ("channel_instance_id")
  WHERE "channel_instance_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "worker_channel_commands" (
  "id" uuid PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "instance_id" text NOT NULL,
  "controller_epoch" integer NOT NULL,
  "seq" bigint NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acked_at" timestamp with time zone,
  CONSTRAINT "worker_channel_commands_state_check" CHECK ("state" IN ('pending', 'acked')),
  CONSTRAINT "worker_channel_commands_seq_check" CHECK ("seq" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worker_channel_commands_run_instance_epoch_seq_uniq"
  ON "worker_channel_commands" USING btree ("run_id", "instance_id", "controller_epoch", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_channel_commands_run_instance_state_seq_idx"
  ON "worker_channel_commands" USING btree ("run_id", "instance_id", "state", "seq");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "worker_channel_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "instance_id" text NOT NULL,
  "worker_seq" bigint NOT NULL,
  "controller_epoch" integer NOT NULL,
  "type" text NOT NULL,
  "payload_sha256" text NOT NULL,
  "result_command_id" uuid REFERENCES "worker_channel_commands"("id"),
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "worker_channel_receipts_worker_seq_check" CHECK ("worker_seq" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worker_channel_receipts_run_instance_worker_seq_uniq"
  ON "worker_channel_receipts" USING btree ("run_id", "instance_id", "worker_seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_channel_receipts_run_instance_worker_seq_idx"
  ON "worker_channel_receipts" USING btree ("run_id", "instance_id", "worker_seq");
