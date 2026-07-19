import { describe, expect, it } from "vitest";

import { parseWorkerUnitEnv } from "../scripts/worker-chat";

const UNIT = `[Unit]
Description=task-orchestrator worker channel
After=network.target

[Service]
User=user
WorkingDirectory=/home/user/task-orchestrator
Environment=PATH=/home/user/node22/bin:/usr/local/bin:/usr/bin:/bin
Environment=TASK_ORCH_INSIDE_WORKER=1
Environment=TASK_ORCH_WORKER_INSTANCE_ID=wi_7a2d4f0f67463f35974c86ea743108b5
Environment=TASK_ORCH_WORKER_CHANNEL_CREDENTIAL=boxe2e.k08jMBFT5pNR08pA9t3nBM49
Environment=TASK_ORCH_WORKER_CHANNEL_ENDPOINT=tcp:0.0.0.0:8787
ExecStart=/home/user/task-orchestrator/node_modules/.bin/tsx scripts/run-worker.ts 113796
Restart=always
`;

describe("parseWorkerUnitEnv", () => {
  it("extracts the channel credential, instance id, and run id from the unit", () => {
    expect(parseWorkerUnitEnv(UNIT)).toEqual({
      credential: "boxe2e.k08jMBFT5pNR08pA9t3nBM49",
      instanceId: "wi_7a2d4f0f67463f35974c86ea743108b5",
      runId: 113796,
    });
  });

  it("throws a helpful error when the unit is not a box-setup worker unit", () => {
    expect(() => parseWorkerUnitEnv("[Service]\nExecStart=/bin/true\n")).toThrow(/box-setup\.sh/);
  });
});
