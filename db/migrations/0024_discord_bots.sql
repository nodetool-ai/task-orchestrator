-- Discord persona bots become configurable in Settings → Discord instead of
-- being env-only (DISCORD_BOT_TOKEN_<PERSONA_ID>). The env vars keep working
-- and are merged in as a fallback at pipe boot; a row here wins for its persona.
--
-- The token is stored as-is: this schema has no encryption precedent
-- (codex_credentials holds plaintext OAuth tokens), the pipe needs the literal
-- value at boot, and the control-plane database is the trust boundary. The API
-- never returns more than the last 4 characters.
--
-- There is deliberately NO allowed_users column. The user allowlist is derived
-- from `channel_identities`: each person links their own Discord id in Settings
-- (channel='discord'), and the union of those ids — plus the legacy
-- DISCORD_ALLOWED_USERS env vars — is who the bots answer. Self-service, and one
-- source of truth shared with `/link` attribution.
CREATE TABLE IF NOT EXISTS "discord_bots" (
  "id" serial PRIMARY KEY,
  "persona_id" text NOT NULL,
  "token" text NOT NULL,
  "application_id" text,
  -- JSON string array, like personas.skill_paths / memories.keywords. Empty ⇒
  -- any channel an allow-listed user can reach the bot in.
  "allowed_channels" text NOT NULL DEFAULT '[]',
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Idempotency via duplicate_object (repo convention, see 0000/0023): a
-- pg_constraint conname lookup would be database-wide and skip creating the FK
-- whenever a sibling schema (parallel test schemas) already has the name.
DO $$ BEGIN
 ALTER TABLE "discord_bots" ADD CONSTRAINT "discord_bots_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- One bot per persona: the pipe binds one gateway connection to a persona id.
CREATE UNIQUE INDEX IF NOT EXISTS "discord_bots_persona_uniq" ON "discord_bots" ("persona_id");
--> statement-breakpoint
-- The allowlist derivation above reads every discord identity on every config
-- load, so give that scan an index (channel_identities only had per-user and
-- per-(channel,external_user) keys).
CREATE INDEX IF NOT EXISTS "channel_identities_channel_idx" ON "channel_identities" ("channel");
