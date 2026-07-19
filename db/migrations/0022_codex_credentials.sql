-- Codex (ChatGPT) OAuth credentials move from ~/.codex/auth.json and the
-- CODEX_ACCESS_TOKEN Fly secret into the control-plane DB, so a UI device-code
-- login persists across deploys and machine restarts. Singleton row: this is a
-- single-tenant orchestrator with one ChatGPT account.
CREATE TABLE IF NOT EXISTS "codex_credentials" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "access_token" text NOT NULL,
  "refresh_token" text,
  "id_token" text,
  "account_id" text,
  "expires_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "codex_credentials_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
-- In-flight device-code logins. The PKCE verifier must outlive the request that
-- produced the authorization URL (the user pastes the code back minutes later,
-- possibly after a redeploy), so it cannot live in module scope. Swept by age.
CREATE TABLE IF NOT EXISTS "codex_login_attempts" (
  "state" text PRIMARY KEY,
  "verifier" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "codex_login_attempts_created_idx" ON "codex_login_attempts" ("created_at");
