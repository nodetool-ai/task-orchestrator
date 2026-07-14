// Gated live proof for the Box lifecycle assumptions used by BoxRunnerProvider.
// It creates only a disposable fork and removes it in finally.  This script
// deliberately logs timing and state only—never Box credentials, worker tokens,
// or Box URLs.

import { makeBoxClient } from "../lib/runner/box-client";
import { waitForBoxCheckpoint, waitForBoxReady } from "../lib/runner/box-waiters";

const TEMPLATE_ID = process.env.TASK_ORCH_BOX_TEMPLATE_ID;
const PREFIX = `task-orch-feasibility-${Date.now().toString(36)}`;

function requireLiveConfig(): string {
  if (process.env.BOX_LIVE_TEST !== "1") {
    throw new Error("Refusing live Box test: set BOX_LIVE_TEST=1 explicitly.");
  }
  if (!process.env.BOX_API_KEY) throw new Error("BOX_API_KEY is required for the live Box test.");
  if (!TEMPLATE_ID) throw new Error("TASK_ORCH_BOX_TEMPLATE_ID is required for the live Box test.");
  return TEMPLATE_ID;
}

async function main(): Promise<void> {
  const templateId = requireLiveConfig();
  const client = makeBoxClient();
  let boxId: string | undefined;
  const timings: Record<string, number> = {};
  const mark = (name: string, from: number) => (timings[name] = Date.now() - from);

  try {
    const forkAt = Date.now();
    const fork = await client.fork(templateId, {
      // Mandatory for every tenant/run machine. The test asserts the real API
      // accepts it rather than inheriting the Box account environment.
      noEnv: true,
      env: { TASK_ORCH_BOX_FEASIBILITY: PREFIX },
    });
    boxId = fork.id;
    await client.update(boxId, { name: PREFIX });
    await waitForBoxReady(client, boxId);
    mark("forkReadyMs", forkAt);

    const marker = `/home/user/.task-orchestrator/${PREFIX}.marker`;
    const repoMarker = `${PREFIX}.repo-marker`;
    // The template declares a single selected checkout. Locate its Git root
    // rather than relying on a local workspace path; command output stays local
    // to the test and contains no credentials.
    const setup = await client.command(boxId, {
      timeoutSeconds: 30,
      command:
        `set -eu; repo=$(find /home/user -type d -name .git -prune -print | head -n 1 | sed 's#/.git$##'); ` +
        `test -n "$repo"; mkdir -p /home/user/.task-orchestrator; ` +
        `printf '%s' ${JSON.stringify(PREFIX)} > ${JSON.stringify(marker)}; ` +
        `printf '%s' ${JSON.stringify(PREFIX)} > "$repo/${repoMarker}"; ` +
        `nohup sh -c 'while :; do sleep 1; done' >/tmp/${PREFIX}.log 2>&1 </dev/null & echo $!`,
    });
    if (!setup.success || !/^\d+\s*$/.test(setup.stdout)) {
      throw new Error("Box detached-process bootstrap did not return a PID.");
    }
    const pid = setup.stdout.trim();
    const alive = await client.command(boxId, { command: `kill -0 ${pid}`, timeoutSeconds: 10 });
    if (!alive.success) throw new Error("Detached process exited before its command request completed.");

    const checkpointAt = Date.now();
    await client.stop(boxId);
    const checkpoint = await waitForBoxCheckpoint(client, boxId, checkpointAt);
    mark("checkpointMs", checkpointAt);

    const resumeAt = Date.now();
    await client.resume(boxId, { noEnv: true });
    await waitForBoxReady(client, boxId);
    const persisted = await client.command(boxId, {
      timeoutSeconds: 15,
      command:
        `set -eu; test -f ${JSON.stringify(marker)}; ` +
        `repo=$(find /home/user -type d -name .git -prune -print | head -n 1 | sed 's#/.git$##'); ` +
        `test -f "$repo/${repoMarker}"; ! kill -0 ${pid} 2>/dev/null`,
    });
    if (!persisted.success) throw new Error("Box snapshot did not preserve markers or retained a detached process.");
    mark("resumeMs", resumeAt);

    console.log(JSON.stringify({ outcome: "passed", snapshotId: checkpoint.snapshot.id, timings }));
  } finally {
    if (boxId) {
      // Stop first (best-effort) so a failed test cannot leave a billable
      // machine running; removal is required only for the disposable fork.
      try {
        const box = await client.get(boxId);
        if (box.state !== "archived") {
          const requestedAt = Date.now();
          await client.stop(boxId);
          await waitForBoxCheckpoint(client, boxId, requestedAt, { timeoutMs: 120_000 });
        }
      } finally {
        await client.remove(boxId).catch(() => {});
      }
    }
  }
}

// Undici intentionally does not keep Node's event loop alive for an in-flight
// request. Keep this CLI process alive until its awaited lifecycle/cleanup
// sequence completes; otherwise `tsx` can exit mid-checkpoint with an orphan.
const keepAlive = setInterval(() => {}, 1_000);
try {
  // Keep the module alive until its cleanup finishes. Calling main().catch()
  // without awaiting lets Node exit while an undici request is still pending.
  await main();
} catch (error: unknown) {
  // Error text is intentionally generic: SDK payloads can contain private URLs.
  console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[redacted-url]") : "Box feasibility failed");
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
