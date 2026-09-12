ALTER TABLE sprite_pool_entries ADD COLUMN reuse_user_id integer REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE sprite_pool_entries ADD COLUMN reuse_repository_id text REFERENCES repositories(id);
--> statement-breakpoint
ALTER TABLE sprite_pool_entries ADD COLUMN reuse_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE sprite_pool_entries DROP CONSTRAINT sprite_pool_entries_state_check;
--> statement-breakpoint
ALTER TABLE sprite_pool_entries ADD CONSTRAINT sprite_pool_entries_state_check CHECK (state IN ('preparing','ready','claimed','recycling','draining','deleting','deleted','failed'));
--> statement-breakpoint
CREATE TABLE sprite_pool_assignments (
 id serial PRIMARY KEY,
 pool_entry_id integer NOT NULL REFERENCES sprite_pool_entries(id) ON DELETE CASCADE,
 run_id integer NOT NULL,
 user_id integer,
 repository_id text,
 lease_token uuid NOT NULL UNIQUE,
 generation integer NOT NULL,
 assigned_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz,
 branch text,
 commit_sha text
);
--> statement-breakpoint
CREATE INDEX sprite_pool_assignments_run_idx ON sprite_pool_assignments(run_id);
--> statement-breakpoint
INSERT INTO sprite_pool_assignments (pool_entry_id,run_id,user_id,repository_id,lease_token,generation,assigned_at,branch)
SELECT pe.id,pe.run_id,r.user_id,r.repo_id,pe.lease_token,COALESCE(ri.worker_generation,1),COALESCE(pe.baseline_restored_at,pe.created_at),r.branch
FROM sprite_pool_entries pe JOIN agent_runs r ON r.id=pe.run_id LEFT JOIN runner_instances ri ON ri.run_id=r.id
WHERE pe.run_id IS NOT NULL AND pe.lease_token IS NOT NULL;
