-- Inbound run channel (server -> worker), symmetric with 0001's outbound
-- run_stream. A new user message fires a lightweight NOTIFY so a long-lived chat
-- worker can wake and run the turn, instead of the server (which runs as root and
-- cannot run the agent CLI) executing it in-process. Payload is the bare run_id
-- (a pure wakeup — the worker re-reads the message via the cursor tail). Fires
-- ONLY on role='user' so the agent's own message/tool/system inserts don't wake it.
CREATE OR REPLACE FUNCTION notify_run_input() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'user' THEN
    PERFORM pg_notify('run_input', NEW.run_id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_messages_notify_input AFTER INSERT ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION notify_run_input();
