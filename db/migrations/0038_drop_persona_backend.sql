-- Engine selection is deployment-wide via TASK_ORCH_AGENT_BACKEND. Personas
-- only pin a model from that engine's catalog.
ALTER TABLE "personas" DROP COLUMN IF EXISTS "backend";
--> statement-breakpoint
UPDATE "personas"
SET "model" = NULL
WHERE "model" IS NOT NULL AND "model" NOT LIKE 'openai/%';
