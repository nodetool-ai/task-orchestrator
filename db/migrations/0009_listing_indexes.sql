-- Composite indexes for large listing pages and their batched hydration queries.
CREATE INDEX IF NOT EXISTS "plan_repos_plan_order_idx" ON "plan_repositories" USING btree ("plan_id","position","repo_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tasks_plan_id_ord_idx" ON "tasks" USING btree ("plan_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_state_id_ord_idx" ON "tasks" USING btree ("state","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_assignee_id_ord_idx" ON "tasks" USING btree ("assignee","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_plan_state_id_ord_idx" ON "tasks" USING btree ("plan_id","state","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_assignee_state_id_ord_idx" ON "tasks" USING btree ("assignee","state","id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "task_notes_task_created_idx" ON "task_notes" USING btree ("task_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ac_task_position_idx" ON "acceptance_criteria" USING btree ("task_id","position","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_plan_id_ord_idx" ON "attachments" USING btree ("plan_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_task_id_ord_idx" ON "attachments" USING btree ("task_id","id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_runs_started_idx" ON "agent_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_task_started_idx" ON "agent_runs" USING btree ("task_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_plan_started_idx" ON "agent_runs" USING btree ("plan_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_status_started_idx" ON "agent_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_repo_started_idx" ON "agent_runs" USING btree ("repo_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_parent_started_idx" ON "agent_runs" USING btree ("parent_run_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_user_started_idx" ON "agent_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_goal_started_idx" ON "agent_runs" USING btree ("goal","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_status_id_idx" ON "agent_runs" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_task_pr_idx" ON "agent_runs" USING btree ("task_id","id") WHERE pr_url IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_live_worker_heartbeat_idx" ON "agent_runs" USING btree ("heartbeat_at") WHERE worker_scope IS NOT NULL;
