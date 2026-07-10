-- Wake-intent lease for runner machines. Stamped immediately BEFORE the Fly
-- start/create call that wakes a suspended/stopped runner, cleared by the
-- worker's first heartbeat, and superseded by age (TASK_ORCH_RUNNER_WAKE_GRACE_MS,
-- default 120s). The lifecycle sweep treats a fresh intent exactly like a live
-- worker claim, closing the wake→first-heartbeat window in which it would see a
-- running machine with a parked run and no claim and suspend it mid-boot
-- (incident: run 139 was suspended 64ms after its wake, then failed by the
-- reaper for the heartbeat the worker never got to write).
ALTER TABLE "runner_instances" ADD COLUMN IF NOT EXISTS "wake_requested_at" timestamp with time zone;
