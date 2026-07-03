-- Realtime run streaming: fire a lightweight NOTIFY on every new agent_event /
-- agent_message so the SSE endpoint can wait on the DB instead of polling. The
-- payload is a tiny wakeup ({run_id, kind, id}) — the row content is still read
-- back via the cursor tail (lib/run-stream), preserving that contract.
CREATE OR REPLACE FUNCTION notify_run_stream() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'run_stream',
    json_build_object('run_id', NEW.run_id, 'kind', TG_TABLE_NAME, 'id', NEW.id)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_events_notify AFTER INSERT ON agent_events
  FOR EACH ROW EXECUTE FUNCTION notify_run_stream();
--> statement-breakpoint
CREATE TRIGGER agent_messages_notify AFTER INSERT ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION notify_run_stream();
