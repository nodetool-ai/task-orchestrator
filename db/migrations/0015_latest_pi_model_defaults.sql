-- Keep newly created personas on the current Pi-supported Anthropic frontier
-- model. Existing persona selections are intentionally left unchanged.
ALTER TABLE "personas" ALTER COLUMN "model_provider" SET DEFAULT 'anthropic';
ALTER TABLE "personas" ALTER COLUMN "model_id" SET DEFAULT 'claude-opus-4-8';
