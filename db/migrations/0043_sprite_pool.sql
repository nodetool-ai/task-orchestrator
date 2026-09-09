CREATE TABLE IF NOT EXISTS "sprite_pool_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "provider" text DEFAULT 'sprites' NOT NULL,
  "sprite_name" text NOT NULL,
  "state" text DEFAULT 'preparing' NOT NULL,
  "baseline_class" text DEFAULT 'generic' NOT NULL,
  "fingerprint" text NOT NULL,
  "baseline_manifest" jsonb NOT NULL,
  "checkpoint_id" text NOT NULL,
  "restore_state" text DEFAULT 'pending' NOT NULL,
  "baseline_restored_at" timestamp with time zone,
  "run_id" integer REFERENCES "agent_runs"("id") ON DELETE SET NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "provider_operation_id" uuid,
  "last_error" text,
  "delete_requested_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sprite_pool_entries_state_check" CHECK ("state" IN ('preparing','ready','claimed','draining','deleting','deleted','failed')),
  CONSTRAINT "sprite_pool_entries_baseline_class_check" CHECK ("baseline_class" IN ('generic','repository')),
  CONSTRAINT "sprite_pool_entries_restore_state_check" CHECK ("restore_state" IN ('pending','restoring','restored','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprite_pool_entries_sprite_name_uniq" ON "sprite_pool_entries" ("sprite_name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sprite_pool_entries_run_id_uniq" ON "sprite_pool_entries" ("run_id") WHERE "run_id" IS NOT NULL AND "state" NOT IN ('deleted','failed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sprite_pool_entries_fingerprint_state_idx" ON "sprite_pool_entries" ("fingerprint", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sprite_pool_entries_state_updated_idx" ON "sprite_pool_entries" ("state", "updated_at");
