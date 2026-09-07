ALTER TABLE "schedule_occurrences" ADD COLUMN "launch_token" text;
--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD COLUMN "launch_claimed_at" timestamptz;
