-- Box runner metadata is additive and nullable: legacy Fly mappings continue
-- to use their machine/volume columns unchanged.
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "box_id" text;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "box_template_id" text;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "box_source_id" text;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "snapshot_id" text;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "snapshot_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "checkpoint_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "last_checkpoint_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "credentials_version" integer;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "credentials_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "worker_version" text;
--> statement-breakpoint
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "last_provider_error" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_instances_box_id_idx" ON "runner_instances" USING btree ("box_id");
