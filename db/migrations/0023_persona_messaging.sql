-- Discord persona bots, milestone 1 (spec
-- docs/superpowers/specs/2026-07-31-discord-personas-messaging-design.md §2).
--
-- channel_threads gains a persona dimension so two persona bots can each hold
-- their own conversation in the same Discord channel, plus an optional user
-- attribution column.
--
-- persona_id is NOT NULL DEFAULT 'implementor' (NOT nullable as the design's
-- sketch had it): Postgres unique indexes treat NULLs as distinct, so a nullable
-- persona column would let duplicate (channel, external_id) rows slip past the
-- new unique index — exactly the invariant the index exists to protect. Every
-- backfilled and future row carries a persona id; 'implementor' is the persona
-- the legacy single-bot bridge was implicitly acting as.
--
-- user_id stays nullable: attribution is opt-in via /link (channel_identities);
-- unlinked users keep talking anonymously, as today.
ALTER TABLE "channel_threads" ADD COLUMN IF NOT EXISTS "persona_id" text NOT NULL DEFAULT 'implementor';
--> statement-breakpoint
ALTER TABLE "channel_threads" ADD COLUMN IF NOT EXISTS "user_id" integer;
--> statement-breakpoint
-- Explicit backfill (the DEFAULT already covers rows that existed at ALTER time;
-- this is belt-and-braces for a re-applied/partial migration).
UPDATE "channel_threads" SET "persona_id" = 'implementor' WHERE "persona_id" IS NULL;
--> statement-breakpoint
-- The FK below needs personas.'implementor' to exist. seedRequiredPersonas()
-- runs *after* migrations on boot, so seed a placeholder here when there is
-- something to backfill and the row is missing. seedRequiredPersonas() detects
-- this placeholder (by its system_prompt marker) and replaces it on next boot.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "channel_threads")
     AND NOT EXISTS (SELECT 1 FROM "personas" WHERE "id" = 'implementor') THEN
    INSERT INTO "personas" ("id", "name", "system_prompt", "tools_profile")
    VALUES ('implementor', 'Implementor', 'Placeholder row inserted by migration 0023; replaced by seedRequiredPersonas() on boot.', 'orchestrator,repo_write');
  END IF;
END $$;
--> statement-breakpoint
-- Idempotency via duplicate_object (repo convention, see 0000): a pg_constraint
-- conname lookup would be database-wide and skip creating the FK in this schema
-- whenever a sibling schema (parallel test schemas) already has the name.
DO $$ BEGIN
 ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Constraint swap: (channel, external_id) → (channel, external_id, persona_id).
DROP INDEX IF EXISTS "channel_threads_channel_external_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_threads_channel_external_persona_uniq"
  ON "channel_threads" ("channel", "external_id", "persona_id");
--> statement-breakpoint
-- Links an external chat account (Discord snowflake) to a local users row via
-- the one-time `/link <api-token>` DM command. Only the association is stored,
-- never the token.
CREATE TABLE IF NOT EXISTS "channel_identities" (
  "id" serial PRIMARY KEY,
  "channel" text NOT NULL,
  "external_user_id" text NOT NULL,
  "user_id" integer NOT NULL,
  "label" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_identities_channel_external_user_uniq"
  ON "channel_identities" ("channel", "external_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_identities_user_idx" ON "channel_identities" ("user_id");
--> statement-breakpoint
-- memories.scope widens from global|repo|task to global|repo|task|persona|user.
-- No DDL: scope is a plain text column with no CHECK constraint; the allowed set
-- is enforced in TypeScript (lib/repo.ts MemoryScope + the memory tool schemas).
SELECT 1;
