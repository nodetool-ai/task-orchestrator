-- Pin the engine together with a persona's model so child runs inherit a
-- compatible backend/model pair. NULL continues to inherit deployment config.
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "backend" text;
