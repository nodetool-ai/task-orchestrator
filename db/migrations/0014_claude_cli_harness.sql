-- 0014_claude_cli_harness: second execution path that runs Claude Code CLI
-- interactively inside tmux instead of the pi agent SDK.
--
--   harness          'pi' (default, existing SDK path) | 'claude_cli'
--   tmux_session     tmux session name (torch-run-<id>) — needed for the
--                    attach hint, cancel-after-restart, and the orphan reaper
--   transcript_path  Claude Code session JSONL, reported by the SessionStart
--                    hook; persisted so a future reattach can resume tailing
--   hook_token       per-run bearer secret authenticating Stop/SessionStart
--                    hook callbacks at /api/runs/:id/hook

ALTER TABLE agent_runs ADD COLUMN harness TEXT NOT NULL DEFAULT 'pi';
ALTER TABLE agent_runs ADD COLUMN tmux_session TEXT;
ALTER TABLE agent_runs ADD COLUMN transcript_path TEXT;
ALTER TABLE agent_runs ADD COLUMN hook_token TEXT;
