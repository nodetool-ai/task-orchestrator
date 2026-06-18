-- Add planning_stage column to agent_runs.
-- NULL = ordinary run (no planning flow active).
-- Non-null values: gathering | spec_review | building_plan | plan_review | committing | done
ALTER TABLE agent_runs ADD COLUMN planning_stage TEXT;
