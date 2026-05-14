-- 0011_api_tokens: per-user API tokens for the MCP server.
--
-- Tokens are stored as bcrypt hashes. The plaintext is shown ONCE at
-- creation time and never persisted. `prefix` (the first 8 chars of the
-- plaintext) lets the UI identify a token by sight without exposing the
-- secret.
--
-- Token format: tot_<32 url-safe-base64 chars>. The "tot_" prefix is
-- recognizable in logs and isn't valid base64 so accidental copy-paste
-- into other systems is loud.

CREATE TABLE IF NOT EXISTS api_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  last_used_at INTEGER,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS api_tokens_prefix_idx ON api_tokens(prefix);
