-- 0004_chats: persistent chat conversations with the Claude Agent SDK.
-- Each chat is bound to a user. Messages store SDK content blocks as JSON so
-- assistant turns with tool_use / tool_result blocks round-trip cleanly.

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT,
  sdk_session_id TEXT,
  total_cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE INDEX IF NOT EXISTS chats_user_idx ON chats(user_id);
CREATE INDEX IF NOT EXISTS chats_updated_idx ON chats(updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE INDEX IF NOT EXISTS chat_messages_chat_idx ON chat_messages(chat_id);
