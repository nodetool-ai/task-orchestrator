// Read-only validation and explicitly-confirmed publication for Box templates.
// This is deliberately separate from BoxRunnerProvider: operator commands must
// never alter a run mapping or participate in normal dispatch lifecycle work.

import type { BoxClient, BoxSnapshot } from "./box-client";
import { BOX_TEMPLATE_MANIFEST_PATH, parseBoxTemplateManifest, type BoxTemplateManifest } from "./box-template";
import { waitForBoxCheckpoint, waitForBoxReady } from "./box-waiters";

/** What can be verified without waking an archived template. */
export type BoxTemplateValidation = {
  boxId: string;
  state: string;
  snapshot: BoxSnapshot;
};

/** Runtime/filesystem checks, available only while a Box is ready or idle. */
export type BoxTemplateRuntimeValidation = {
  manifest: BoxTemplateManifest;
  nodeVersion: string;
  origin: string;
};

export type BoxTemplateValidationOptions = {
  /** An operator can pin the configured template checkout path. */
  expectedRepositoryPath?: string;
  /** Optional extra guard when a deployment has one selected repository. */
  expectedRepository?: string;
};

export type BoxTemplatePublishOptions = BoxTemplateValidationOptions & {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
};

export type BoxTemplatePublication = BoxTemplateValidation & BoxTemplateRuntimeValidation & {
  snapshot: BoxSnapshot;
  resumeActionId: string;
  stopActionId: string;
};

const BOX_ID = /^bx_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const WORKER_ENTRYPOINT = "/home/user/task-orchestrator/dist/run-worker.js";

function assertBoxId(boxId: string): void {
  if (!BOX_ID.test(boxId)) throw new Error("Box template id must begin with bx_ and contain only Box ID characters.");
}

function shellQuote(value: string): string {
  // All dynamic shell arguments here come from a parsed manifest. Quote them
  // anyway so a malformed future manifest cannot turn validation into command
  // injection before its path/origin checks report the error.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function checkedCommand(client: BoxClient, boxId: string, name: string, command: string): Promise<string> {
  const result = await client.command(boxId, { command, cwd: ".", timeoutSeconds: 20 });
  if (!result.success || result.timedOut || result.exitCode !== 0) {
    // Do not include stdout/stderr: provider command output can contain URLs,
    // repository config, or an accidentally echoed credential.
    throw new Error(`Box template ${name} check failed.`);
  }
  return result.stdout;
}

function assertOrigin(origin: string, repository: string): void {
  const normalized = origin.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!normalized.endsWith(`/${repository}`) && !normalized.endsWith(`:${repository}`)) {
    throw new Error(`Box template repository origin does not match ${repository}.`);
  }
}

/**
 * Validate a stopped/published template without writing to Box. An archived
 * Box cannot execute the command endpoint, so this intentionally verifies only
 * the durable Box/snapshot metadata. Filesystem/runtime checks run during the
 * explicitly confirmed publish flow after a no-env resume.
 */
export async function validateBoxTemplate(
  client: BoxClient,
  boxId: string,
  options: BoxTemplateValidationOptions = {}
): Promise<BoxTemplateValidation> {
  assertBoxId(boxId);
  const box = await client.get(boxId);
  if (box.state !== "archived") {
    throw new Error(`Box template ${boxId} must be archived before validation (current state: ${box.state}).`);
  }
  if (box.lastSnapshotStatus !== "completed") {
    throw new Error(`Box template ${boxId} does not have a completed final snapshot.`);
  }

  const snapshot = await client.getLatestBoxSnapshot(boxId);
  if (!snapshot || snapshot.status !== "completed") {
    throw new Error(`Box template ${boxId} has no completed latest snapshot.`);
  }
  return { boxId, state: box.state, snapshot };
}

/** Run the filesystem checks that require a ready/idle Box command endpoint. */
export async function validateRunningBoxTemplate(
  client: BoxClient,
  boxId: string,
  options: BoxTemplateValidationOptions = {}
): Promise<BoxTemplateRuntimeValidation> {
  const manifestText = await checkedCommand(
    client,
    boxId,
    "manifest",
    `cat ${shellQuote(BOX_TEMPLATE_MANIFEST_PATH)}`
  );
  const manifest = parseBoxTemplateManifest(manifestText);
  if (options.expectedRepositoryPath && manifest.repositoryPath !== options.expectedRepositoryPath) {
    throw new Error("Box template manifest repository path does not match TASK_ORCH_BOX_REPO_PATH.");
  }
  if (options.expectedRepository && manifest.repository !== options.expectedRepository) {
    throw new Error(`Box template manifest repository does not match ${options.expectedRepository}.`);
  }

  const nodeVersion = (await checkedCommand(
    client,
    boxId,
    "worker runtime",
    `test -x ${shellQuote(WORKER_ENTRYPOINT)} && node --version`
  )).trim();
  if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(nodeVersion)) {
    throw new Error("Box template Node runtime did not report a valid version.");
  }

  const repo = shellQuote(manifest.repositoryPath);
  const origin = (await checkedCommand(client, boxId, "repository origin", `git -C ${repo} remote get-url origin`)).trim();
  assertOrigin(origin, manifest.repository);
  const status = await checkedCommand(client, boxId, "repository cleanliness", `git -C ${repo} status --porcelain=v1`);
  if (status.trim()) throw new Error("Box template repository has uncommitted changes.");

  // These paths are deliberately narrow: .env.example is allowed, while files
  // commonly containing real credentials must not survive into a template.
  await checkedCommand(
    client,
    boxId,
    "secret-file",
    [
      `for p in "$HOME/.env" ${repo}/.env ${repo}/.env.local "$HOME/.aws/credentials"; do`,
      '  if [ -e "$p" ]; then exit 1; fi',
      "done",
    ].join(" ")
  );
  await checkedCommand(
    client,
    boxId,
    "active-worker",
    // `[n]ode` matches a real worker command but not this pgrep invocation's
    // own command line. Without it, every validation falsely sees itself as a
    // running worker.
    `if pgrep -f ${shellQuote(`[n]ode ${WORKER_ENTRYPOINT}`)} >/dev/null; then exit 1; fi`
  );

  return { manifest, nodeVersion, origin };
}

/** Fail closed at the CLI seam before any Box client is constructed. */
export function requireTemplatePublishConfirmation(confirmed: unknown): void {
  if (confirmed !== true) {
    throw new Error("Refusing to publish a Box template without --yes.");
  }
}

/**
 * Publish an already valid archived template. The command intentionally does
 * not run arbitrary setup hooks: any build/warm work must be performed by an
 * explicit operator process before publication, so this CLI never executes
 * repository-provided commands with account credentials in scope.
 */
export async function publishBoxTemplate(
  client: BoxClient,
  boxId: string,
  options: BoxTemplatePublishOptions = {}
): Promise<BoxTemplatePublication> {
  const validation = await validateBoxTemplate(client, boxId, options);
  const resumed = await client.resume(boxId, { noEnv: true });
  await waitForBoxReady(client, boxId, {
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    now: options.now,
  });
  const runtime = await validateRunningBoxTemplate(client, boxId, options);

  // Capture the checkpoint boundary immediately before the stop request: a
  // snapshot created before the just-completed runtime checks cannot prove the
  // published template state persisted.
  const requestedAt = new Date((options.now ?? Date.now)());
  const stopped = await client.stop(boxId);
  const checkpoint = await waitForBoxCheckpoint(client, boxId, requestedAt, {
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    now: options.now,
  });
  return {
    ...validation,
    ...runtime,
    state: checkpoint.box.state,
    snapshot: checkpoint.snapshot,
    resumeActionId: resumed.id,
    stopActionId: stopped.id,
  };
}
