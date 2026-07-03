-- 0013_attachments: image & artifact attachments for plans and tasks.
--
-- An attachment belongs to exactly one owner: a plan OR a task (never both,
-- never neither). The CHECK enforces the XOR. Bytes live in a BLOB so the DB
-- stays self-contained — no external object store to keep in sync with the
-- SQLite file. `kind` is 'image' for image/* mime types, 'artifact' otherwise;
-- it's derived at insert time so list views and the UI can branch without
-- re-parsing the mime type.
--
-- Both FKs cascade: deleting a plan or task drops its attachments with it.

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id     TEXT REFERENCES plans(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  content     BLOB NOT NULL,
  author      TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  CHECK ((plan_id IS NOT NULL) <> (task_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS attachments_plan_idx ON attachments(plan_id);
CREATE INDEX IF NOT EXISTS attachments_task_idx ON attachments(task_id);
