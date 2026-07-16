ALTER TABLE "worker_channel_receipts" ADD COLUMN IF NOT EXISTS "invoke_payload" jsonb;
