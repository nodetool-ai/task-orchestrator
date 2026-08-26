ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "sprite_name" text;
CREATE INDEX IF NOT EXISTS "runner_instances_sprite_name_idx" ON "runner_instances" ("sprite_name");
