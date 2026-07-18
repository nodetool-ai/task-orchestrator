// lib/runner/box-template-builder.ts
//
// Executes one app-managed template build inside a FRESH BLANK box (created via
// client.create — no operator base box), mirroring scripts/install-box-template.sh,
// wrapped in emitTemplateBuildLifecycle so the triggering run's stepper shows
// live progress. Never throws: every failure is recorded on the registry row
// and emitted as runner_box_template_failed.
import { config } from "../config";
import type { BoxClient } from "./box-client";
import { emitBoxEvent } from "./box";
import { BOX_CLAUDE_BINARY } from "./box-env";
import { BOX_TEMPLATE_MANIFEST_PATH, BOX_TEMPLATE_WORKER_PROTOCOL_VERSION } from "./box-template";
import { emitTemplateBuildLifecycle } from "./box-template-events";
import { markEnvironmentFailed, markEnvironmentReady, setEnvironmentDetail } from "./environments";
import { waitForBoxCheckpoint, waitForBoxReady } from "./box-waiters";

const BUILD_STEPS = [
  "cloning-worker",
  "installing-deps",
  "building-worker",
  "pruning",
  "cloning-agent-repo",
  "writing-manifest",
  "verifying-worker",
  "archiving",
] as const;

const WORKER_DIR = "/home/user/task-orchestrator";

/** Where the pruning step parks the single-file worker; the ONLY worker
 *  artifact a finished template contains. The bootstrap in box.ts launches
 *  this path (with a legacy fallback for pre-bundle templates). */
const BUNDLE_PATH = "/home/user/worker/run-worker.js";

/**
 * Pre-archive smoke test. Run 26 archived a snapshot whose claude binary
 * could not exec; runs 26/27 then died milliseconds into their first turn.
 * Verify BOTH launch paths the worker depends on: (a) the standalone bundle,
 * copied alone into a scratch dir so a hidden node_modules dependency cannot
 * pass by accident (exit 2 = its own usage check, the full dependency graph
 * loaded), and (b) the Box's preinstalled claude binary. `sync` so the
 * checkpoint can never seal half-written pages.
 */
const VERIFY_WORKER_COMMAND =
  `set -eu; d=$(mktemp -d); cp ${BUNDLE_PATH} "$d/run-worker.js"; cd "$d"; ` +
  `node run-worker.js >/dev/null 2>&1 || rc=$?; test "\${rc:-0}" -eq 2 || { echo "bundle isolation check failed (exit \${rc:-0}, expected 2)" >&2; exit 1; }; ` +
  `${BOX_CLAUDE_BINARY} --version; sync`;

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runBoxTemplateBuild(
  client: BoxClient,
  input: { registryId: number; runId: number | null; workerSha: string },
  opts: {
    waitReady?: typeof waitForBoxReady;
    waitCheckpoint?: typeof waitForBoxCheckpoint;
    /** Test seams: injectable clock + sleep so polling doesn't wall-clock wait. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const waitReady = opts.waitReady ?? waitForBoxReady;
  const waitCheckpoint = opts.waitCheckpoint ?? waitForBoxCheckpoint;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Run-triggered builds stream run events; manual (page-triggered) builds don't.
  const emit =
    input.runId != null
      ? (type: string, payload: Record<string, unknown>) => emitBoxEvent(input.runId as number, type, payload)
      : async () => {};
  let boxId: string | undefined;

  // Each box `command` call has a platform-enforced max duration well under a
  // long `npm ci`. So a build step is LAUNCHED detached (setsid, output +
  // exit-code redirected to marker files) via one short call, then POLLED with
  // short calls until it finishes or the step budget elapses. This keeps every
  // API call brief while the step itself runs as long as it needs.
  const CALL_TIMEOUT_S = 60;
  const run = async (boxIdNow: string, label: string, command: string): Promise<void> => {
    const base = `/tmp/tmpl-step-${label}`;
    const inner = `(${command}) > ${base}.log 2>&1; echo $? > ${base}.rc`;
    // setsid + </dev/null fully detaches the step from the command's shell so it
    // survives this API call returning; the box VM persists between calls.
    const launch = `rm -f ${base}.rc ${base}.log; setsid sh -c ${shq(inner)} </dev/null >/dev/null 2>&1 & echo launched`;
    const started = await client.command(boxIdNow, { command: launch, cwd: ".", timeoutSeconds: CALL_TIMEOUT_S });
    if (!started.success || started.timedOut || started.exitCode !== 0) {
      const detail = (started.stderr || started.stdout || "").slice(-500);
      throw new Error(`Template build step ${label} failed to launch: ${detail}`);
    }

    const readTail = async (): Promise<string> => {
      try {
        const t = await client.command(boxIdNow, {
          command: `tail -c 2000 ${base}.log 2>/dev/null || true`,
          cwd: ".",
          timeoutSeconds: CALL_TIMEOUT_S,
        });
        return (t.stdout ?? "").slice(-2_000);
      } catch {
        return "(log unavailable)";
      }
    };

    const deadline = now() + config.box.buildStepTimeoutSeconds * 1000;
    for (;;) {
      await sleep(config.box.pollMs);
      if (now() > deadline) {
        throw new Error(`Template build step ${label} timed out after ${config.box.buildStepTimeoutSeconds}s: ${await readTail()}`);
      }
      const probe = await client.command(boxIdNow, {
        command: `if [ -f ${base}.rc ]; then cat ${base}.rc; else echo __running__; fi`,
        cwd: ".",
        timeoutSeconds: CALL_TIMEOUT_S,
      });
      // A transient probe hiccup (unreachable/timeout) is not fatal — keep polling.
      if (!probe.success || probe.timedOut) continue;
      const out = (probe.stdout ?? "").trim();
      if (out === "" || out === "__running__") continue;
      const rc = Number.parseInt(out, 10);
      if (Number.isNaN(rc)) continue;
      if (rc === 0) return;
      throw new Error(`Template build step ${label} failed (exit ${rc}): ${await readTail()}`);
    }
  };

  try {
    await emitTemplateBuildLifecycle({
      emit,
      workerSha: input.workerSha,
      reason: "no-template",
      steps: BUILD_STEPS,
      build: async (step) => {
        // Every step advances the row's `detail` in ADDITION to the run-event
        // stepper, so a manual (runId-less) build is still observable by
        // polling the row (the page reads it); run-triggered builds get both.
        const stepAndDetail = async (name: string): Promise<void> => {
          await setEnvironmentDetail(input.registryId, name);
          await step(name);
        };

        // Provision a fresh blank box — no operator-provided base. A blank
        // image ships with git/node/npm; the cloning-worker step verifies that
        // runtime first so a missing tool fails legibly.
        const blank = await client.create({ env: {}, noEnv: true });
        boxId = blank.id;
        await waitReady(client, boxId, { timeoutMs: config.box.readyTimeoutMs });

        const repoPath = config.box.repoPath ?? "/home/user/repository";

        await stepAndDetail("cloning-worker");
        await run(boxId, "cloning-worker",
          `set -eu; command -v git >/dev/null && command -v node >/dev/null && command -v npm >/dev/null || { echo "blank box missing git/node/npm" >&2; exit 127; }; test ! -e ${shq(WORKER_DIR)}; git clone --branch ${shq(config.box.workerRepoRef)} ${shq(config.box.workerRepoUrl)} ${shq(WORKER_DIR)}; cd ${shq(WORKER_DIR)}; git checkout ${input.workerSha}`);

        await stepAndDetail("installing-deps");
        await run(boxId, "installing-deps",
          `set -eu; cd ${shq(WORKER_DIR)}; npm ci --omit=optional`);

        await stepAndDetail("building-worker");
        await run(boxId, "building-worker",
          `set -eu; cd ${shq(WORKER_DIR)}; npm run build:worker:standalone; test -s dist/run-worker.standalone.js`);

        await stepAndDetail("pruning");
        await run(boxId, "pruning",
          `set -eu; mkdir -p $(dirname ${shq(BUNDLE_PATH)}); cp ${shq(`${WORKER_DIR}/dist/run-worker.standalone.js`)} ${shq(BUNDLE_PATH)}; rm -rf ${shq(WORKER_DIR)}`);

        await stepAndDetail("cloning-agent-repo");
        await run(boxId, "cloning-agent-repo",
          `set -eu; test ! -e ${shq(repoPath)}; git clone --depth 1 ${shq(config.box.agentRepoUrl)} ${shq(repoPath)}`);

        await stepAndDetail("writing-manifest");
        const manifest = JSON.stringify({
          formatVersion: 1,
          workerBuildSha: input.workerSha,
          workerProtocolVersion: BOX_TEMPLATE_WORKER_PROTOCOL_VERSION,
          repository: config.box.agentRepo,
          repositoryPath: repoPath,
          workerEntryPath: BUNDLE_PATH,
        });
        await run(boxId, "writing-manifest",
          `set -eu; mkdir -p /home/user/.task-orchestrator; printf '%s\\n' ${shq(manifest)} > ${shq(BOX_TEMPLATE_MANIFEST_PATH)}`);

        await stepAndDetail("verifying-worker");
        await run(boxId, "verifying-worker", VERIFY_WORKER_COMMAND);

        await stepAndDetail("archiving");
        const requestedAt = Date.now();
        await client.stop(boxId);
        await waitCheckpoint(client, boxId, requestedAt, { timeoutMs: config.box.readyTimeoutMs * 5 });

        await markEnvironmentReady(input.registryId, { boxId });
        return { templateId: boxId };
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markEnvironmentFailed(input.registryId, message);
    if (boxId) {
      try {
        await client.stop(boxId);
      } catch {
        // Best-effort cleanup; the retention sweep owns stragglers.
      }
    }
  }
}
