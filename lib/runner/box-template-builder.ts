// lib/runner/box-template-builder.ts
//
// Executes one app-managed template build inside a forked base Box, mirroring
// scripts/install-box-template.sh, wrapped in emitTemplateBuildLifecycle so
// the triggering run's stepper shows live progress. Never throws: every
// failure is recorded on the registry row and emitted as
// runner_box_template_failed.
import { config } from "../config";
import type { BoxClient } from "./box-client";
import { emitBoxEvent } from "./box";
import { BOX_TEMPLATE_MANIFEST_PATH, BOX_TEMPLATE_WORKER_PROTOCOL_VERSION } from "./box-template";
import { emitTemplateBuildLifecycle } from "./box-template-events";
import { markTemplateFailed, markTemplateReady } from "./box-template-registry";
import { waitForBoxCheckpoint, waitForBoxReady } from "./box-waiters";

const BUILD_STEPS = [
  "cloning-worker",
  "installing-deps",
  "building-worker",
  "cloning-agent-repo",
  "installing-agent-deps",
  "writing-manifest",
  "archiving",
] as const;

const WORKER_DIR = "/home/user/task-orchestrator";

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runBoxTemplateBuild(
  client: BoxClient,
  input: { registryId: number; runId: number; workerSha: string },
  opts: {
    waitReady?: typeof waitForBoxReady;
    waitCheckpoint?: typeof waitForBoxCheckpoint;
  } = {}
): Promise<void> {
  const waitReady = opts.waitReady ?? waitForBoxReady;
  const waitCheckpoint = opts.waitCheckpoint ?? waitForBoxCheckpoint;
  const emit = (type: string, payload: Record<string, unknown>) =>
    emitBoxEvent(input.runId, type, payload);
  let boxId: string | undefined;

  const run = async (boxIdNow: string, label: string, command: string): Promise<void> => {
    const result = await client.command(boxIdNow, {
      command,
      cwd: ".",
      timeoutSeconds: config.box.buildStepTimeoutSeconds,
    });
    if (!result.success || result.timedOut || result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "").slice(-2_000);
      throw new Error(`Template build step ${label} failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${detail}`);
    }
  };

  try {
    await emitTemplateBuildLifecycle({
      emit,
      workerSha: input.workerSha,
      reason: "no-template",
      steps: BUILD_STEPS,
      build: async (step) => {
        const baseBoxId = config.box.baseBoxId;
        if (!baseBoxId) {
          throw new Error("TASK_ORCH_BOX_BASE_ID is required for app-managed template builds.");
        }
        const forked = await client.fork(baseBoxId, { env: {}, noEnv: true });
        boxId = forked.id;
        await waitReady(client, boxId, { timeoutMs: config.box.readyTimeoutMs });

        const repoPath = config.box.repoPath ?? "/home/user/repository";

        await step("cloning-worker");
        await run(boxId, "cloning-worker",
          `set -eu; test ! -e ${shq(WORKER_DIR)}; git clone --branch ${shq(config.box.workerRepoRef)} ${shq(config.box.workerRepoUrl)} ${shq(WORKER_DIR)}; cd ${shq(WORKER_DIR)}; git checkout ${input.workerSha}`);

        await step("installing-deps");
        await run(boxId, "installing-deps", `set -eu; cd ${shq(WORKER_DIR)}; npm ci`);

        await step("building-worker");
        await run(boxId, "building-worker",
          `set -eu; cd ${shq(WORKER_DIR)}; npm run build:worker; test -s dist/run-worker.js`);

        await step("cloning-agent-repo");
        await run(boxId, "cloning-agent-repo",
          `set -eu; test ! -e ${shq(repoPath)}; git clone --depth 1 ${shq(config.box.agentRepoUrl)} ${shq(repoPath)}`);

        await step("installing-agent-deps");
        await run(boxId, "installing-agent-deps", `set -eu; cd ${shq(repoPath)}; npm ci`);

        await step("writing-manifest");
        const manifest = JSON.stringify({
          formatVersion: 1,
          workerBuildSha: input.workerSha,
          workerProtocolVersion: BOX_TEMPLATE_WORKER_PROTOCOL_VERSION,
          repository: config.box.agentRepo,
          repositoryPath: repoPath,
        });
        await run(boxId, "writing-manifest",
          `set -eu; mkdir -p /home/user/.task-orchestrator; printf '%s\\n' ${shq(manifest)} > ${shq(BOX_TEMPLATE_MANIFEST_PATH)}`);

        await step("archiving");
        const requestedAt = Date.now();
        await client.stop(boxId);
        await waitCheckpoint(client, boxId, requestedAt, { timeoutMs: config.box.readyTimeoutMs * 5 });

        await markTemplateReady(input.registryId, boxId);
        return { templateId: boxId };
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markTemplateFailed(input.registryId, message);
    if (boxId) {
      try {
        await client.stop(boxId);
      } catch {
        // Best-effort cleanup; the retention sweep owns stragglers.
      }
    }
  }
}
