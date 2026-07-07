ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_messages_idempotency_key_idx" ON "agent_messages" USING btree ("idempotency_key");--> statement-breakpoint
