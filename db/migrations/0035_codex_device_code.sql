-- Replace the browser authorization-code paste attempt with the real OpenAI
-- device-code values. In-flight attempts are intentionally discarded; they are
-- short-lived and cannot be converted between the two protocols.
DROP TABLE IF EXISTS "codex_login_attempts";
--> statement-breakpoint
CREATE TABLE "codex_login_attempts" (
  "device_auth_id" text PRIMARY KEY NOT NULL,
  "user_code" text NOT NULL,
  "interval_seconds" integer NOT NULL DEFAULT 5,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "codex_login_attempts_created_idx" ON "codex_login_attempts" ("created_at");
