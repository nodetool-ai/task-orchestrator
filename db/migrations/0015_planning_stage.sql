-- 0015_planning_stage: per-run marker for the gated plan-creation flow.
--
-- A "planning run" is a `<plan>` run driven by the planning agent. The
-- planning_stage column tracks where it sits in the spec → plan → tasks
-- arc, which drives server-side gate enforcement (the agent's write tools
-- check the stage) and which review affordance the run view renders.
--
-- Stage machine:
--   gathering → spec_review → building_plan → plan_review → committing → done
--
-- NULL = an ordinary (non-planning) run. Existing rows stay NULL and are
-- unaffected.

ALTER TABLE agent_runs ADD COLUMN planning_stage TEXT;
