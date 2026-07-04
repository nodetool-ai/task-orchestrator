import { describe, expect, it } from "vitest";
import { makeFlyClient } from "../../lib/runner/fly-client";

// Gated live spike. Run manually with:
// FLY_LIVE_TEST=1 FLY_API_TOKEN=... FLY_APP_NAME=... npx vitest run __tests__/integration/fly-live.test.ts
// Observed Fly states should be recorded here after a real run; the provider maps
// expected states: created/starting/started/suspending/suspended/stopping/stopped/destroyed.
const live = process.env.FLY_LIVE_TEST === "1";

describe.skipIf(!live)("Fly Machines live API", () => {
  it("creates, starts, suspends, restarts, and destroys a tiny machine", async () => {
    const fly = makeFlyClient();
    const region = process.env.TASK_ORCH_FLY_REGION || "ams";
    const suffix = `${Date.now()}`;
    const volume = await fly.createVolume({ name: `test-vol-${suffix}`, region, size_gb: 1 });
    let machineId: string | null = null;
    try {
      const machine = await fly.createMachine({
        name: `test-machine-${suffix}`,
        region,
        config: {
          image: "registry.fly.io/flyio/hellofly:latest",
          env: {},
          mounts: [{ volume: volume.id, path: "/data" }],
          guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
          restart: { policy: "no" },
        },
      });
      machineId = machine.id;
      await fly.startMachine(machineId).catch(() => {});
      await fly.suspendMachine(machineId);
      await fly.startMachine(machineId);
      const after = await fly.getMachine(machineId);
      expect(after?.id).toBe(machineId);
    } finally {
      if (machineId) await fly.destroyMachine(machineId, { force: true }).catch(() => {});
      await fly.destroyVolume(volume.id).catch(() => {});
    }
  }, 120_000);
});
