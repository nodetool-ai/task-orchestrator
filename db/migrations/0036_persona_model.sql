-- Personas may pin a provider-qualified model for child runs. Explicit per-run
-- selections still take precedence; NULL inherits the deployment default.
ALTER TABLE "personas" ADD COLUMN IF NOT EXISTS "model" text;
