-- Preserve future supervision for pre-v2 runs by making the old direct-parent
-- interest explicit. Do not subscribe ancestors, replay history, or resurrect
-- an interest which the run already cancelled.
INSERT INTO run_event_subscriptions
  (id, subscriber_run_id, source_run_id, event_types, attempt_mode,
   resolved_attempt, replay_mode, lifetime, keep_open, start_revision, client_key)
SELECT gen_random_uuid(), p.id, c.id,
       '["run.attempt_finished","run.question_opened"]'::jsonb, 'exact',
       c.attempt, 'future_only', 'attempt', true,
       COALESCE((SELECT MAX(f.revision) FROM run_source_events f WHERE f.source_run_id = c.id), 0) + 1,
       'default-supervision:' || c.id || ':' || c.attempt
FROM agent_runs c JOIN agent_runs p ON p.id = c.parent_run_id
WHERE p.delivery_version = 1 AND p.id <> c.id
  AND p.status NOT IN ('completed','failed','cancelled','closed','budget_exhausted')
  AND c.status NOT IN ('completed','failed','cancelled','closed','budget_exhausted')
ON CONFLICT DO NOTHING;
