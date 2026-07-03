-- Add thinking_level (reasoning level) column to agent_runs.
-- NULL = inherit the persona's level (which itself may be NULL = model default).
-- Non-null values: low | medium | high | xhigh
ALTER TABLE agent_runs ADD COLUMN thinking_level TEXT;
