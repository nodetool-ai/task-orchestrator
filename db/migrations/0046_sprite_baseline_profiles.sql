CREATE TABLE "sprite_baseline_profiles" (
  "repository_id" text NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "spec" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("repository_id", "user_id")
);
