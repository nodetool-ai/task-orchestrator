-- 0018_channel_threads: map an external chat conversation (e.g. a Discord DM or
-- guild channel/thread) to a chat run (agent_runs row, goal='<chat>'). One row
-- per (channel, external_id). ON DELETE CASCADE so deleting the run drops the
-- mapping; the channel bridge (lib/pipe) then re-creates a fresh run on the next
-- message.
CREATE TABLE IF NOT EXISTS channel_threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,
  external_id TEXT NOT NULL,
  run_id      INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_threads_channel_external_uniq
  ON channel_threads(channel, external_id);
CREATE INDEX IF NOT EXISTS channel_threads_run_idx ON channel_threads(run_id);
