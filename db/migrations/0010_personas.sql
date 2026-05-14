-- 0010_personas: persona registry + per-persona memory + agent_runs.persona_id.
--
-- Personas bundle (system prompt, model, tools profile, skills, memory, budgets)
-- per role. Rows are seeded from lib/personas/*.ts at boot (db/seed-personas.ts);
-- the table is queryable so agent_runs can FK to it and the UI can list options.

CREATE TABLE IF NOT EXISTS personas (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  system_prompt   TEXT NOT NULL,
  model_provider  TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  thinking_level  TEXT,
  tools_profile   TEXT NOT NULL,
  skill_paths     TEXT NOT NULL DEFAULT '[]',
  budget_max_turns    INTEGER,
  budget_max_seconds  INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE TABLE IF NOT EXISTS persona_memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  UNIQUE(persona_id, scope)
);

CREATE INDEX IF NOT EXISTS persona_memories_persona_idx
  ON persona_memories(persona_id);

ALTER TABLE agent_runs ADD COLUMN persona_id TEXT
  REFERENCES personas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_runs_persona_idx ON agent_runs(persona_id);
