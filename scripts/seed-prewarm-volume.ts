// scripts/seed-prewarm-volume.ts
//
// (Re)populate the prewarm SEED volume with a fresh nodetool `npm ci`.
//
// The runner image no longer bakes the ~5 GB prewarm (it blew past Fly's 8 GB
// image cap). Instead the deps live on a persistent seed volume that
// FlyRunnerProvider.create() forks into each run (source_volume_id). This job
// keeps that seed fresh:
//
//   1. ensure the seed volume exists (create sized TASK_ORCH_PREWARM_SEED_GB)
//   2. boot a one-shot Machine that mounts it and runs build-prewarm.sh into
//      <mount>/prewarm (init.exec overrides the worker entrypoint)
//   3. wait for the Machine to stop, then destroy it (KEEP the volume)
//
// Success is keyed on the .prewarm-repo marker build-prewarm.sh writes only
// after a clean install. A failed/partial seed leaves no marker, so runs simply
// cold-install — never broken.
//
// Env: FLY_API_TOKEN (runner-app deploy token), GH_TOKEN (contents:read for the
// clone). Optional: TASK_ORCH_FLY_APP (runner app, default below),
// FLY_RUNNER_IMAGE, TASK_ORCH_FLY_REGION, TASK_ORCH_PREWARM_SEED_VOLUME,
// TASK_ORCH_PREWARM_SEED_GB, PREWARM_REPO.

import { makeFlyClient } from "../lib/runner/fly-client";

const APP = process.env.TASK_ORCH_FLY_APP || "task-orchestrator-runners";
const REGION = process.env.TASK_ORCH_FLY_REGION || "ams";
const SEED_NAME = process.env.TASK_ORCH_PREWARM_SEED_VOLUME || "prewarm_seed";
const SEED_GB = Number(process.env.TASK_ORCH_PREWARM_SEED_GB || "20");
const PREWARM_REPO = process.env.PREWARM_REPO || "nodetool-ai/nodetool";
const IMAGE = process.env.FLY_RUNNER_IMAGE || `registry.fly.io/${APP}:latest`;
const GH_TOKEN = process.env.GH_TOKEN;
const MOUNT = "/mnt/session";
const PREWARM_DIR = `${MOUNT}/prewarm`;
const TIMEOUT_MS = Number(process.env.TASK_ORCH_PREWARM_SEED_TIMEOUT_MS || String(30 * 60_000));
const POLL_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!GH_TOKEN) throw new Error("GH_TOKEN is required to clone the prewarm repo");
  const client = makeFlyClient({ appName: APP });

  // Clean up any leftover seed machines from a prior interrupted run.
  for (const m of await client.listMachines()) {
    if (m.id && m.name?.startsWith("prewarm-seed-")) {
      console.log(`destroying stale seed machine ${m.id}`);
      await client.destroyMachine(m.id, { force: true }).catch(() => {});
    }
  }

  // 1. Ensure the seed volume.
  const volumes = await client.listVolumes();
  let seed = volumes.find((v) => v.name === SEED_NAME && v.region === REGION);
  // Track whether WE created it this run: if the install then fails we destroy it
  // so no empty seed lingers (FlyRunnerProvider would otherwise fork garbage into
  // every run). A pre-existing seed (last good prewarm) is left intact on failure.
  const createdFresh = !seed;
  if (seed) {
    console.log(`reusing seed volume ${seed.id} (${SEED_NAME}, ${REGION})`);
  } else {
    console.log(`creating seed volume ${SEED_NAME} (${SEED_GB} GB, ${REGION})`);
    seed = await client.createVolume({ name: SEED_NAME, region: REGION, size_gb: SEED_GB });
  }

  // 2. One-shot Machine that runs the prewarm into the mounted volume. init.exec
  //    replaces the worker entrypoint; `test -f .prewarm-repo` makes the process
  //    exit non-zero when the install didn't complete, so we can detect failure.
  const script =
    `set -o pipefail; bash /app/scripts/build-prewarm.sh ${PREWARM_DIR} ${PREWARM_REPO}; ` +
    `if [ -f ${PREWARM_DIR}/.prewarm-repo ]; then echo SEED_OK; else echo SEED_FAILED; exit 1; fi`;
  const name = `prewarm-seed-${Date.now()}`;
  console.log(`booting seed machine ${name} (image ${IMAGE})`);
  const machine = await client.createMachine({
    name,
    region: REGION,
    config: {
      image: IMAGE,
      // build-prewarm.sh reads GH_TOKEN (runtime fallback) and borrows the
      // image-baked blobless mirror at /opt/repo-cache as a clone reference.
      env: { GH_TOKEN: GH_TOKEN!, REPO_CACHE_DIR: "/opt/repo-cache" },
      mounts: [{ volume: seed.id, path: MOUNT }],
      // nodetool's npm ci needs ~16 GB (it OOM'd on Depot; succeeded on GitHub's
      // 16 GB). 8 shared vCPU × 2048 MB = 16 GB is the shared-cpu ceiling.
      guest: { cpu_kind: "shared", cpus: 8, memory_mb: 16384 },
      restart: { policy: "no" },
      init: { exec: ["bash", "-lc", script] },
      metadata: { managed_by: "task-orchestrator", role: "prewarm-seed" },
    },
  });
  console.log(`seed machine ${machine.id} started; waiting up to ${Math.round(TIMEOUT_MS / 60_000)}m...`);

  // 3. Wait for completion.
  const start = Date.now();
  let final: { state: string; exitCode?: number } | null = null;
  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(POLL_MS);
    const m = await client.getMachine(machine.id);
    if (!m) {
      final = { state: "gone" };
      break;
    }
    if (m.state === "stopped" || m.state === "destroyed" || m.state === "failed") {
      final = { state: m.state, exitCode: m.exitCode };
      break;
    }
  }

  const exit = final?.exitCode;
  console.log(`seed machine final: state=${final?.state ?? "timeout"} exit=${exit ?? "?"}`);
  await client.destroyMachine(machine.id, { force: true }).catch(() => {});

  const failure =
    !final
      ? `seed machine did not finish within ${Math.round(TIMEOUT_MS / 60_000)}m`
      : final.state === "failed"
        ? "seed machine entered failed state"
        : typeof exit === "number" && exit !== 0
          ? `prewarm install exited non-zero (${exit}) — seed NOT refreshed`
          : null;

  if (failure) {
    // Don't leave an empty/partial seed for create() to fork. Only destroy a
    // volume WE created this run; a pre-existing seed keeps its last good state.
    if (createdFresh) {
      console.log(`destroying freshly-created empty seed volume ${seed.id}`);
      await client.destroyVolume(seed.id).catch(() => {});
    }
    throw new Error(failure);
  }
  console.log(`prewarm seed volume ${seed.id} is ready (repo ${PREWARM_REPO}).`);
}

main().catch((err) => {
  console.error("[seed-prewarm-volume] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
