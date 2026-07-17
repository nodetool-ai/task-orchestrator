// Box managed-runner provider. This file owns first-turn provisioning and the
// detached worker hand-off; checkpoint/resume/reconciliation land separately.

import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions, runnerInstances } from "@/db/schema";
import { config, validateBoxConfig } from "../config";
import { buildBoxWorkerEnv } from "./box-env";
import { makeBoxClient, type BoxClient, type BoxLimits } from "./box-client";
import { normalizeBoxApiError, serializeBoxApiError } from "./box-errors";
import { BOX_TEMPLATE_MANIFEST_PATH, parseBoxTemplateManifest } from "./box-template";
import { resolveBoxTemplate, setTemplateBuildStarter } from "./environments";
import { runBoxTemplateBuild } from "./box-template-builder";
import { waitForBoxCheckpoint, waitForBoxReady } from "./box-waiters";
import { boxStateToRunnerState } from "./box-waiters";
import { isWakeIntentFresh, isWorkerClaimLive } from "./lifecycle";
import { newChannelInstanceId } from "../worker-channel/credential";
import { boxChannelDialEndpoint, parseBoxHostUrl } from "../worker-channel/dispatch-env";
import type {
  CreateRunnerInput,
  RunnerAdmission,
  RunnerAdmissionInput,
  RunnerProvider,
  RunnerRef,
} from "./provider";
import { recordRunnerEvent } from "./telemetry";

const MANIFEST_COMMAND_TIMEOUT_SECONDS = 15;
const WORKER_BOOTSTRAP_TIMEOUT_SECONDS = 30;
const BOOTSTRAP_LOG_TIMEOUT_SECONDS = 10;
const BOOTSTRAP_LOG_TAIL_LINES = 200;
const SWEEP_KEY = "__taskOrchBoxRunnerSweep";
// The worker binds this fixed TCP port (plan section 2) inside the Box; the
// ascii.dev `host` proxy exposes it as a public WSS URL the control plane dials.
const BOX_CHANNEL_PORT = 8787;
const HOST_COMMAND_TIMEOUT_SECONDS = 30;
// Expose the worker's channel port and print its public HTTPS URL. `host` is
// the Box CLI's port-hosting tool (docs.ascii.dev/box/hosting); the absolute
// $HOME path is robust against a minimal command-API PATH. `host <port>` opens
// the firewall + registers the reverse proxy (a bare `host url` did not
// establish forwarding in testing), and prints `https://<sub>-<port>.on.ascii.dev?_token=…`.
const HOST_CHANNEL_COMMAND =
  `"$HOME/.ascii/host" ${BOX_CHANNEL_PORT} --title task-orch-worker-channel`;

/** Strict ownership boundary for retention/orphan cleanup. */
export function isTaskOrchestratorBoxName(name: string | undefined): boolean {
  return !!name && /^task-orch-run-\d+-[A-Za-z0-9_-]+$/.test(name);
}

/** Pure dry-run selector: only an aged, unmapped, orchestrator-named Box qualifies. */
export function boxOrphansForCleanup(
  boxes: Array<{ id: string; name?: string; createdAt?: Date }>,
  mappedIds: ReadonlySet<string>,
  now = Date.now(),
  minAgeMs = config.box.retentionMs
): string[] {
  return boxes
    .filter((box) => isTaskOrchestratorBoxName(box.name) && !mappedIds.has(box.id))
    .filter((box) => !!box.createdAt && now - box.createdAt.getTime() >= minAgeMs)
    .map((box) => box.id);
}

// Keep this shell text static: it contains no environment values or secrets.
// The worker inherits the allowlisted per-Box environment passed during fork.
//
// The bootstrap writes its own milestones before Node evaluates the worker
// bundle. That gives us useful evidence when the worker exits before its first
// application log or heartbeat (the exact failure mode a Box command's normal
// success result cannot expose).
const WORKER_BOOTSTRAP_COMMAND = [
  'mkdir -p "$SESSION_ROOT/logs"',
  'log="$SESSION_ROOT/logs/runner.log"',
  'entry="/home/user/task-orchestrator/dist/run-worker.js"',
  // Do not dump the environment: it contains the signed worker token and may
  // contain agent credentials. The metadata below is sufficient to distinguish
  // a missing/stale template artifact from a failure inside the worker process.
  '{ printf "%s [box-bootstrap] starting run_id=%s entry=%s\\n" "$(date -Iseconds 2>/dev/null || date)" "$TASK_ORCH_RUN_ID" "$entry"; command -v node || true; node --version || true; ls -l "$entry" || true; } >>"$log" 2>&1',
  'if [ ! -f "$entry" ]; then printf "%s [box-bootstrap] worker entrypoint missing\\n" "$(date -Iseconds 2>/dev/null || date)" >>"$log"; exit 127; fi',
  // Keep the background launch and its PID handling in a brace group. Joining
  // a trailing `&` with `&&` is invalid POSIX shell syntax (`& &&`).
  '{ nohup node "$entry" "$TASK_ORCH_RUN_ID" >>"$log" 2>&1 </dev/null & pid=$!; printf "%s [box-bootstrap] launched pid=%s\\n" "$(date -Iseconds 2>/dev/null || date)" "$pid" >>"$log"; }',
  // A one-second probe catches syntax/import/config failures before the
  // provider returns success. Long-running workers remain fully detached.
  'sleep 1',
  'if kill -0 "$pid" 2>/dev/null; then printf "%s [box-bootstrap] alive pid=%s\\n" "$(date -Iseconds 2>/dev/null || date)" "$pid" >>"$log"; else wait "$pid"; status=$?; printf "%s [box-bootstrap] exited-early pid=%s status=%s\\n" "$(date -Iseconds 2>/dev/null || date)" "$pid" "$status" >>"$log"; exit "$status"; fi',
  'printf "%s\\n" "$pid"',
].join(" && ");

const BOOTSTRAP_LOG_TAIL_COMMAND =
  `if [ -f "$SESSION_ROOT/logs/runner.log" ]; then tail -n ${BOOTSTRAP_LOG_TAIL_LINES} ` +
  '"$SESSION_ROOT/logs/runner.log"; fi';

function boxName(input: CreateRunnerInput): string {
  // input.scope already carries dispatch's collision-resistant run nonce.
  return `task-orch-${input.scope}`.slice(0, 120);
}

function parseDetachedPid(stdout: string): number {
  const match = /^\s*([1-9]\d*)\s*$/.exec(stdout);
  if (!match) throw new Error("Box worker bootstrap did not return a valid PID");
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) throw new Error("Box worker bootstrap returned an invalid PID");
  return pid;
}

export async function emitBoxEvent(runId: number, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  recordRunnerEvent(type, { provider: "box", runId, fields: payload });
  try {
    await db.insert(agentEvents).values({
      sessionId: runId,
      type,
      payload: JSON.stringify(payload),
      createdAt: new Date(),
    });
  } catch {
    // Runner telemetry must never turn a successfully launched worker into a
    // failed one merely because its observability mirror is unavailable.
  }
}

/**
 * Persist the early Box-side log before the worker's own log flusher starts.
 * This is best-effort observability: a busy/unavailable command endpoint must
 * never change runner lifecycle semantics.
 */
async function captureBootstrapLog(box: BoxClient, runId: number, boxId: string): Promise<void> {
  try {
    const result = await box.command(boxId, {
      command: BOOTSTRAP_LOG_TAIL_COMMAND,
      cwd: ".",
      timeoutSeconds: BOOTSTRAP_LOG_TIMEOUT_SECONDS,
    });
    if (!result.success || result.timedOut || result.exitCode !== 0 || !result.stdout) return;
    // The command is static and the bootstrap never prints its environment.
    // Cap defensively in case a worker emits a very large stack trace early.
    const workerLog = result.stdout.slice(-64 * 1024);
    await db.update(agentSessions).set({ workerLog }).where(eq(agentSessions.id, runId));
    await emitBoxEvent(runId, "runner_box_bootstrap_log", { boxId, captured: true });
  } catch {
    // A Box may still be busy transitioning between command requests. The
    // worker's regular in-process flusher remains the fallback once it starts.
  }
}

/** Pure capacity decision; dispatch supplies its in-process claim reservations. */
export function boxAdmissionDecision(
  limits: BoxLimits,
  input: Pick<RunnerAdmissionInput, "reservedActive">,
  applicationCap = config.box.maxActive
): RunnerAdmission {
  const detail = `${limits.startBlockedReason ?? ""} ${limits.blockedReason ?? ""}`.toLowerCase();
  if (!limits.canStart) {
    if (limits.checkoutRequired || /billing|payment|checkout/.test(detail)) {
      return { decision: "reject", message: "Box billing setup is required before runners can start." };
    }
    if (/auth|unauthori[sz]ed|account.*setup|setup.*account/.test(detail)) {
      return { decision: "reject", message: "Box account setup or authentication must be completed before runners can start." };
    }
    return { decision: "defer", reason: "Box currently cannot start another runner." };
  }

  // A local claim reserves a slot until Box's account count catches up. max()
  // avoids double-counting once a just-forked Box appears in activeBoxes.
  const active = Math.max(limits.activeBoxes, input.reservedActive);
  const accountCap = limits.maxActiveBoxes > 0 ? limits.maxActiveBoxes : undefined;
  const selectedCap = applicationCap > 0 ? Math.min(applicationCap, accountCap ?? applicationCap) : accountCap;
  if (selectedCap != null && active >= selectedCap) {
    return { decision: "defer", reason: `Box active-runner capacity (${selectedCap}) is exhausted.` };
  }
  return { decision: "admit" };
}

export class BoxRunnerProvider implements RunnerProvider {
  readonly kind = "box" as const;
  private client: BoxClient | undefined;
  private readonly clientFactory: () => BoxClient;

  /** Passing a structural fake keeps provider tests independent of the SDK. */
  constructor(clientOrFactory: BoxClient | (() => BoxClient) = makeBoxClient) {
    this.clientFactory = typeof clientOrFactory === "function" ? clientOrFactory : () => clientOrFactory;
    // App-managed template builds run in-process, fire-and-forget; the
    // registry row + lifecycle events carry all observable state.
    setTemplateBuildStarter((row) => {
      // Run-triggered builds always carry a runId; manual/page builds bypass the
      // starter and call runBoxTemplateBuild directly (with runId: null).
      if (row.runId == null) return;
      void runBoxTemplateBuild(this.box(), { ...row, runId: row.runId }).catch((error) => {
        console.error(`box template build ${row.registryId} crashed:`, error);
      });
    });
  }

  private box(): BoxClient {
    return (this.client ??= this.clientFactory());
  }

  /** Provider-owned account/capacity gate, called inside dispatch's claim lock. */
  async admit(input: RunnerAdmissionInput): Promise<RunnerAdmission> {
    try {
      const template = await resolveBoxTemplate({ runId: input.runId });
      if (template.kind === "building") {
        return {
          decision: "defer",
          reason:
            template.builderRunId === input.runId
              ? "Building box template…"
              : `Waiting for box template build (started by run #${template.builderRunId})`,
        };
      }
      if (template.kind === "cooldown") {
        // A recent build failed; keep deferring without rebuilding until the
        // cooldown elapses (the pump retries and eventually a fresh build runs,
        // or TASK_ORCH_MAX_DEFER_MS hard-fails the run). Surface the reason.
        const detail = (template.error ?? "").split("\n")[0].slice(0, 140);
        return {
          decision: "defer",
          reason: detail
            ? `Box template build failed, retrying (${detail})`
            : "Box template build failed; retrying shortly",
        };
      }
      return boxAdmissionDecision(await this.box().limits(), input);
    } catch (error) {
      const normalized = await normalizeBoxApiError(error);
      switch (normalized.category) {
        case "unauthorized":
          return { decision: "reject", message: "Box authentication failed; verify BOX_API_KEY." };
        case "billing-required":
          return { decision: "reject", message: "Box billing is required before runners can start." };
        case "invalid-request":
        case "not-found":
          return { decision: "reject", message: `Box account setup rejected admission: ${normalized.message}` };
        case "capacity":
        case "rate-limited":
        case "transient":
        case "conflict":
        case "unknown":
          return { decision: "defer", reason: normalized.message };
      }
    }
  }

  async create(input: CreateRunnerInput): Promise<RunnerRef | null> {
    validateBoxConfig();
    const box = this.box();
    const existing = await this.getInstance(input.runId);
    // Resume-identity rule: a run that already has a channel instance id (its
    // Box snapshot survives resume) reuses it so the derived worker credential
    // stays stable; a first-time provision takes the id dispatch reserved (or
    // mints one). The worker binds its WS listener under this identity and the
    // control plane dials it via the host proxy.
    const channelInstanceId =
      existing?.channelInstanceId ?? input.channelInstanceId ?? newChannelInstanceId();
    if (existing?.boxId) {
      // A retry continues its tracked fork. It must never fork a second Box for
      // a mapping that is still usable/provisioning.
      if (existing.credentialsExpiresAt && existing.credentialsExpiresAt.getTime() <= Date.now()) {
        return this.refreshCredentials(input, existing.boxId, channelInstanceId);
      }
      const current = await box.get(existing.boxId);
      if (current.state === "archived") return this.resumeExisting(input, existing.boxId, channelInstanceId);
      return this.readyAndLaunch(input, existing.boxId, channelInstanceId);
    }

    const [run] = await db
      .select({ repoId: agentSessions.repoId })
      .from(agentSessions)
      .where(eq(agentSessions.id, input.runId));
    if (!run?.repoId) throw new Error(`Box runner requires a repository for run ${input.runId}`);

    // B017 owns full admission. This early account-read nevertheless fails
    // before a fork when Box explicitly says it cannot start anything.
    const admission = await this.admit({ runId: input.runId, reservedActive: 0 });
    if (admission.decision !== "admit") {
      throw new Error(
        admission.decision === "reject"
          ? admission.message
          : admission.decision === "defer"
            ? admission.reason ?? "Box account cannot start a runner at this time"
            : "Box runner admission rejected this run"
      );
    }

    const template = await resolveBoxTemplate({ runId: input.runId });
    if (template.kind === "building" || template.kind === "cooldown") {
      // Admission should have deferred; a direct create() without a ready
      // template is a caller bug, and forking without one is impossible.
      throw new Error("Box template is not ready; the run must remain deferred.");
    }
    const templateId = template.boxId;
    const env = buildBoxWorkerEnv({
      runId: input.runId,
      repoId: run.repoId,
      channelInstanceId,
      ...(template.kind === "ready" ? { templateVersion: template.workerSha } : {}),
    });

    let boxId: string | undefined;
    try {
      await emitBoxEvent(input.runId, "runner_box_forking", { templateId });
      const forked = await box.fork(templateId, { env, noEnv: true });
      boxId = forked.id;

      // Persist before the first readiness poll so timeouts and process crashes
      // leave an auditable, recoverable mapping rather than an active orphan.
      await db
        .insert(runnerInstances)
        .values({
          runId: input.runId,
          provider: "box",
          boxId,
          boxTemplateId: templateId,
          state: "starting",
          repoPath: config.box.repoPath ?? "/home/user/repository",
          lastStartedAt: new Date(),
          credentialsVersion: 1,
          lastProviderError: null,
          channelInstanceId,
        })
        .onConflictDoUpdate({
          target: runnerInstances.runId,
          set: {
            provider: "box",
            boxId,
            boxTemplateId: templateId,
            state: "starting",
            lastStartedAt: new Date(),
            credentialsVersion: 1,
            lastProviderError: null,
            channelInstanceId,
          },
        });

      await box.update(boxId, { name: boxName(input) });
      return await this.readyAndLaunch(input, boxId, channelInstanceId);
    } catch (error) {
      const normalized = await normalizeBoxApiError(error);
      if (boxId) {
        await this.recordFailure(input.runId, boxId, normalized);
        // Preserve the snapshot for diagnosis/retry; deletion is a retention
        // decision, never a provisioning-error cleanup action.
        await box.stop(boxId).catch(() => {});
      }
      throw error;
    }
  }

  private async readyAndLaunch(
    input: CreateRunnerInput,
    boxId: string,
    channelInstanceId: string,
  ): Promise<RunnerRef> {
    const box = this.box();
    try {
      await waitForBoxReady(box, boxId, {
        timeoutMs: config.box.readyTimeoutMs,
        pollMs: config.box.pollMs,
      });

      // Box commands require a Box-relative cwd. The manifest itself stays at
      // its fixed absolute template path so it is independent of the checkout.
      const manifestResult = await box.command(boxId, {
        command: `cat ${BOX_TEMPLATE_MANIFEST_PATH}`,
        cwd: ".",
        timeoutSeconds: MANIFEST_COMMAND_TIMEOUT_SECONDS,
      });
      if (!manifestResult.success || manifestResult.timedOut || manifestResult.exitCode !== 0) {
        throw new Error("Box template manifest command failed");
      }
      const manifest = parseBoxTemplateManifest(manifestResult.stdout);
      if (config.box.repoPath && manifest.repositoryPath !== config.box.repoPath) {
        throw new Error("Box template manifest repository path does not match TASK_ORCH_BOX_REPO_PATH");
      }
      await db
        .update(runnerInstances)
        .set({ repoPath: manifest.repositoryPath, workerVersion: manifest.workerBuildSha, state: "running" })
        .where(and(eq(runnerInstances.runId, input.runId), eq(runnerInstances.boxId, boxId)));
      await emitBoxEvent(input.runId, "runner_box_ready", { boxId, repository: manifest.repository });

      const launched = await box.command(boxId, {
        command: WORKER_BOOTSTRAP_COMMAND,
        cwd: ".",
        timeoutSeconds: WORKER_BOOTSTRAP_TIMEOUT_SECONDS,
      });
      if (!launched.success || launched.timedOut || launched.exitCode !== 0) {
        await captureBootstrapLog(box, input.runId, boxId);
        throw new Error("Box worker bootstrap command failed");
      }
      parseDetachedPid(launched.stdout);
      // Capture the bootstrap header immediately. If the detached Node process
      // dies before it reaches scripts/run-worker.ts, this is the only durable
      // evidence available to the control plane.
      await captureBootstrapLog(box, input.runId, boxId);

      // DispatchRun performs the guarded scope→Box-ID handoff immediately after
      // create() returns. Check ownership here as well so a claim lost while the
      // command ran cannot leave a billed worker running until the next sweep.
      const [owner] = await db
        .select({ workerScope: agentSessions.workerScope })
        .from(agentSessions)
        .where(eq(agentSessions.id, input.runId));
      if (owner?.workerScope !== input.scope) {
        await box.stop(boxId).catch(() => {});
        throw new Error("Box worker claim ownership was lost during bootstrap");
      }

      // Expose the worker's WS listener through the ascii.dev host proxy and
      // derive the control-plane dial endpoint (wss URL + `_port_auth` token).
      // The worker may still be binding 8787 — `host` opens the firewall and
      // registers the proxy regardless; the control plane's boot backoff retries
      // the dial until the listener is up.
      const channelEndpoint = await this.hostWorkerChannel(box, boxId);
      await db
        .update(runnerInstances)
        .set({ channelInstanceId, channelEndpoint })
        .where(and(eq(runnerInstances.runId, input.runId), eq(runnerInstances.boxId, boxId)));
      await emitBoxEvent(input.runId, "runner_box_channel_hosted", { boxId });
      return { runId: input.runId, handle: boxId, provider: "box", channelInstanceId, channelEndpoint };
    } catch (error) {
      const normalized = await normalizeBoxApiError(error);
      await captureBootstrapLog(box, input.runId, boxId);
      await this.recordFailure(input.runId, boxId, normalized);
      await box.stop(boxId).catch(() => {});
      throw error;
    }
  }

  /**
   * Run `host <channel port>` inside the Box and derive the control-plane dial
   * endpoint from its public HTTPS URL. Idempotent: re-hosting an already-hosted
   * port returns the same subdomain and token, so a retry/resume rebuilds the
   * same endpoint. Throws when the command fails or prints no usable URL.
   */
  private async hostWorkerChannel(box: BoxClient, boxId: string): Promise<string> {
    const result = await box.command(boxId, {
      command: HOST_CHANNEL_COMMAND,
      cwd: ".",
      timeoutSeconds: HOST_COMMAND_TIMEOUT_SECONDS,
    });
    if (!result.success || result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `Box host command for the worker channel failed (exit ${result.exitCode ?? "null"}${result.timedOut ? ", timed out" : ""})`,
      );
    }
    const hosted = parseBoxHostUrl(result.stdout);
    if (!hosted) throw new Error("Box host command did not return a public URL for the worker channel");
    return boxChannelDialEndpoint(hosted.origin, hosted.token);
  }

  /** Durable checkpoint: stop is complete only after a new completed snapshot. */
  async checkpoint(runId: number, requestedAt = new Date()): Promise<void> {
    const instance = await this.getInstance(runId);
    if (!instance?.boxId) throw new Error(`Box runner ${runId} has no current Box`);
    const boxId = instance.boxId;
    const box = this.box();
    try {
      await db
        .update(runnerInstances)
        .set({ checkpointRequestedAt: requestedAt })
        .where(and(eq(runnerInstances.runId, runId), eq(runnerInstances.boxId, boxId)));
      await emitBoxEvent(runId, "runner_checkpoint_requested", { boxId });
      const current = await box.get(boxId);
      if (current.state !== "archived") await box.stop(boxId);
      // An already-archived Box cannot make a newer snapshot without resuming.
      // Its current completed snapshot is therefore valid evidence for this
      // idempotent call; a stop we just requested still requires a new one.
      const checkpointSince =
        current.state === "archived"
          ? instance.checkpointRequestedAt ?? current.snapshotCompletedAt ?? requestedAt
          : requestedAt;
      const checkpoint = await waitForBoxCheckpoint(box, boxId, checkpointSince, {
        timeoutMs: config.box.readyTimeoutMs,
        pollMs: config.box.pollMs,
      });
      await db
        .update(runnerInstances)
        .set({
          state: "stopped",
          snapshotId: checkpoint.snapshot.id,
          snapshotCompletedAt: checkpoint.snapshot.completedAt ?? checkpoint.box.snapshotCompletedAt ?? null,
          lastCheckpointAt: new Date(),
          lastProviderError: null,
        })
        .where(and(eq(runnerInstances.runId, runId), eq(runnerInstances.boxId, boxId)));
      await emitBoxEvent(runId, "runner_checkpoint_completed", { boxId, snapshotId: checkpoint.snapshot.id });
    } catch (error) {
      const normalized = await normalizeBoxApiError(error);
      await this.recordFailure(runId, boxId, normalized);
      await emitBoxEvent(runId, "runner_checkpoint_failed", { boxId, error: serializeBoxApiError(normalized) });
      throw error;
    }
  }

  /** Resume the archived current Box; no template fork occurs on this path. */
  private async resumeExisting(
    input: CreateRunnerInput,
    boxId: string,
    channelInstanceId: string,
  ): Promise<RunnerRef> {
    const box = this.box();
    try {
      await db
        .update(runnerInstances)
        .set({ wakeRequestedAt: new Date(), state: "starting" })
        .where(and(eq(runnerInstances.runId, input.runId), eq(runnerInstances.boxId, boxId)));
      await box.resume(boxId, { noEnv: true });
      await emitBoxEvent(input.runId, "runner_box_resumed", { boxId });
      return await this.readyAndLaunch(input, boxId, channelInstanceId);
    } catch (error) {
      await this.recordFailure(input.runId, boxId, await normalizeBoxApiError(error));
      // A resume failure retains the old archived mapping for reconciliation; do
      // not stop/delete it here because it may still be the only snapshot.
      throw error;
    }
  }

  /**
   * Replace expired per-Box credentials by forking the archived run Box. The
   * source mapping remains untouched until the replacement has passed readiness,
   * so a failed refresh leaves the original snapshot resumable.
   */
  async refreshCredentials(
    input: CreateRunnerInput,
    sourceBoxId?: string,
    channelInstanceIdArg?: string,
  ): Promise<RunnerRef> {
    const instance = await this.getInstance(input.runId);
    const sourceId = sourceBoxId ?? instance?.boxId;
    if (!sourceId) throw new Error(`Box runner ${input.runId} has no source Box to refresh`);
    // The worker channel identity is deterministic and does NOT expire (unlike
    // the Box per-fork account credentials this refresh rotates), so the same
    // channel instance id — hence the same derived worker credential — carries
    // across the fork. Reuse the caller's id, else the row's, else mint.
    const channelInstanceId =
      channelInstanceIdArg ?? instance?.channelInstanceId ?? newChannelInstanceId();
    const source = await this.box().get(sourceId);
    if (source.state !== "archived") throw new Error("Box credential refresh requires an archived source Box");
    const [run] = await db
      .select({ repoId: agentSessions.repoId })
      .from(agentSessions)
      .where(eq(agentSessions.id, input.runId));
    if (!run?.repoId) throw new Error(`Box runner requires a repository for run ${input.runId}`);

    const box = this.box();
    let replacementId: string | undefined;
    try {
      const env = buildBoxWorkerEnv({ runId: input.runId, repoId: run.repoId, channelInstanceId });
      replacementId = (await box.fork(sourceId, { env, noEnv: true })).id;
      await box.update(replacementId, { name: boxName(input) });
      await waitForBoxReady(box, replacementId, { timeoutMs: config.box.readyTimeoutMs, pollMs: config.box.pollMs });

      // Only after readiness is the replacement current. Preserve sourceId for
      // retention cleanup after the replacement's first verified checkpoint.
      await db
        .update(runnerInstances)
        .set({
          boxId: replacementId,
          boxSourceId: sourceId,
          state: "starting",
          credentialsVersion: (instance?.credentialsVersion ?? 0) + 1,
          credentialsExpiresAt: null,
          lastProviderError: null,
          channelInstanceId,
        })
        .where(and(eq(runnerInstances.runId, input.runId), eq(runnerInstances.boxId, sourceId)));
      await emitBoxEvent(input.runId, "runner_box_rotated", { boxId: replacementId, sourceBoxId: sourceId });
      return await this.readyAndLaunch(input, replacementId, channelInstanceId);
    } catch (error) {
      if (replacementId) await box.stop(replacementId).catch(() => {});
      await this.recordFailure(input.runId, sourceId, await normalizeBoxApiError(error));
      throw error;
    }
  }

  private async recordFailure(runId: number, boxId: string, error: ReturnType<typeof serializeBoxApiError>): Promise<void> {
    await db
      .update(runnerInstances)
      .set({ lastProviderError: JSON.stringify(serializeBoxApiError(error)), state: "starting" })
      .where(and(eq(runnerInstances.runId, runId), eq(runnerInstances.boxId, boxId)));
    await emitBoxEvent(runId, "runner_failed", { boxId, error: serializeBoxApiError(error) });
  }

  /** Best-effort cancellation fallback; B014 verifies checkpoints in detail. */
  async stop(handle: string): Promise<void> {
    const [mapped] = await db
      .select({ runId: runnerInstances.runId })
      .from(runnerInstances)
      .where(eq(runnerInstances.boxId, handle));
    if (mapped) {
      await this.checkpoint(mapped.runId);
      return;
    }
    await this.box().stop(handle);
  }

  async sweep(): Promise<void> {
    const g = globalThis as Record<string, unknown>;
    if (g[SWEEP_KEY]) return;
    g[SWEEP_KEY] = true;
    try {
      const rows = await db
        .select({
          runId: runnerInstances.runId,
          boxId: runnerInstances.boxId,
          state: runnerInstances.state,
          createdAt: runnerInstances.createdAt,
          lastStartedAt: runnerInstances.lastStartedAt,
          lastCheckpointAt: runnerInstances.lastCheckpointAt,
          workerScope: agentSessions.workerScope,
          heartbeatAt: agentSessions.heartbeatAt,
          wakeRequestedAt: runnerInstances.wakeRequestedAt,
        })
        .from(runnerInstances)
        .leftJoin(agentSessions, eq(agentSessions.id, runnerInstances.runId))
        .where(and(eq(runnerInstances.provider, "box"), isNotNull(runnerInstances.boxId)));
      for (const row of rows) {
        if (!row.boxId) continue;
        try {
          const remote = await this.box().get(row.boxId);
          const state = boxStateToRunnerState(remote.state);
          await db
            .update(runnerInstances)
            .set({ state })
            .where(and(eq(runnerInstances.runId, row.runId), eq(runnerInstances.boxId, row.boxId)));
          // Recoverable Box errors remain mapped for retry/inspection; never
          // treat them as filesystem loss or clear SDK session state.
          if (remote.state === "error") {
            await this.recordFailure(row.runId, row.boxId, {
              category: "unknown",
              message: "Box reported recoverable error state during reconciliation",
            });
            continue;
          }
          if (!["ready", "idle", "running"].includes(remote.state)) continue;
          if (isWorkerClaimLive({ workerScope: row.workerScope, heartbeatAt: row.heartbeatAt })) continue;
          if (isWakeIntentFresh({ wakeRequestedAt: row.wakeRequestedAt })) continue;
          const idleSince = Math.max(
            row.createdAt.getTime(),
            row.lastStartedAt?.getTime() ?? 0,
            row.lastCheckpointAt?.getTime() ?? 0
          );
          if (Date.now() - idleSince >= config.box.idleStopMs) await this.checkpoint(row.runId);
        } catch (error) {
          await this.recordFailure(row.runId, row.boxId, await normalizeBoxApiError(error));
        }
      }
    } finally {
      delete g[SWEEP_KEY];
    }
  }

  startMonitor(): void {
    // The global dispatch pump calls sweep(); avoid an independent interval that
    // could overlap a checkpoint on a long-running control-plane process.
  }

  /** Retention is explicit and conservative; returns ids selected/deleted. */
  async cleanup(options: { dryRun?: boolean; now?: number } = {}): Promise<string[]> {
    const now = options.now ?? Date.now();
    const rows = await db
      .select({
        runId: runnerInstances.runId,
        boxId: runnerInstances.boxId,
        boxSourceId: runnerInstances.boxSourceId,
        state: runnerInstances.state,
        createdAt: runnerInstances.createdAt,
        lastCheckpointAt: runnerInstances.lastCheckpointAt,
      })
      .from(runnerInstances)
      .where(eq(runnerInstances.provider, "box"));
    const mapped = new Set(rows.flatMap((row) => [row.boxId, row.boxSourceId]).filter((id): id is string => !!id));
    const account = await this.box().boxes({ limit: 100 });
    const candidates = new Set(boxOrphansForCleanup(account.boxes, mapped, now));
    for (const row of rows) {
      // Current Boxes are retained only once archived/stopped beyond the window.
      if (
        row.boxId &&
        row.state === "stopped" &&
        now - (row.lastCheckpointAt?.getTime() ?? row.createdAt.getTime()) >= config.box.retentionMs
      ) {
        candidates.add(row.boxId);
      }
      // Replacement source is safe only after the new current Box checkpointed.
      if (row.boxSourceId && row.lastCheckpointAt) candidates.add(row.boxSourceId);
    }
    const selected = [...candidates];
    if (options.dryRun) return selected;
    for (const boxId of selected) {
      try {
        const info = await this.box().get(boxId);
        if (info.state !== "archived") await this.box().stop(boxId);
        await this.box().remove(boxId);
        await emitBoxEvent(rows.find((row) => row.boxId === boxId || row.boxSourceId === boxId)?.runId ?? 0, "runner_box_deleted", { boxId });
      } catch {
        // A later cleanup pass retries. Never clear a mapping after a failed delete.
      }
    }
    return selected;
  }

  private async getInstance(runId: number): Promise<typeof runnerInstances.$inferSelect | null> {
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, runId));
    return row ?? null;
  }
}

export { WORKER_BOOTSTRAP_COMMAND, parseDetachedPid };
