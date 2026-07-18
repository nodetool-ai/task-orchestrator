// lib/runner/box-client.ts
// Narrow, project-owned adapter around the generated Box SDK. Runner providers
// depend on the structural BoxClient interface below, never on SDK response
// types, so unit tests can use simple fakes and SDK upgrades stay contained.

import { BoxApi, Configuration } from "@asciidev/box-sdk";
import { config } from "../config";

export const DEFAULT_BOX_BASE_URL = "https://ascii.dev/api/box/v1";

export interface BoxInfo {
  id: string;
  state: string;
  name?: string;
  createdAt?: Date;
  updatedAt?: Date;
  snapshotCompletedAt?: Date;
  lastSnapshotStatus?: string;
}

export interface BoxLimits {
  canStart: boolean;
  activeBoxes: number;
  maxActiveBoxes: number;
  blockedReason?: string;
  startBlockedReason?: string;
  checkoutRequired?: boolean;
}

export interface BoxList {
  boxes: BoxInfo[];
  nextCursor?: string;
}

export interface BoxSnapshot {
  id: string;
  status: string;
  createdAt?: Date;
  completedAt?: Date;
}

export interface BoxAction {
  id: string;
  status: string;
}

export interface BoxCommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * The only Box API surface runner code may use. It is intentionally structural
 * so provider tests can construct a fake object without importing the generated
 * SDK or setting Box credentials.
 */
export interface BoxClient {
  limits(): Promise<BoxLimits>;
  boxes(input?: { limit?: number; cursor?: string; state?: string }): Promise<BoxList>;
  get(boxId: string): Promise<BoxInfo>;
  update(boxId: string, input: { name?: string; ttlSeconds?: number | null; subdomain?: string }): Promise<BoxInfo>;
  fork(boxId: string, input: { env: Record<string, string>; noEnv: true }): Promise<BoxAction>;
  /** Provision a fresh blank box (POST /boxes). Used by app-managed template
   *  builds, which start from a clean image rather than an operator base box. */
  create(input: { env: Record<string, string>; noEnv: true }): Promise<BoxInfo>;
  resume(boxId: string, input?: { noEnv?: boolean }): Promise<BoxAction>;
  stop(boxId: string): Promise<BoxAction>;
  remove(boxId: string): Promise<void>;
  command(boxId: string, input: { command: string; cwd?: string; timeoutSeconds?: number }): Promise<BoxCommandResult>;
  getLatestBoxSnapshot(boxId: string): Promise<BoxSnapshot | null>;
  /** Write one file into the Box work directory (PUT /boxes/:id/files). Used
   *  by blank provisioning to PUSH the worker bundle when the control plane
   *  has no box-reachable URL (local dev). Optional so narrow test fakes need
   *  not implement it; the real client always does. */
  writeFile?(boxId: string, input: { path: string; content: string; encoding?: "utf8" | "base64" }): Promise<void>;
}

// This mirrors only the generated SDK calls used by this adapter. It is an
// implementation seam (not a provider dependency) that permits mapper tests
// without mocking module internals.
export interface BoxSdkApi {
  limits(): Promise<unknown>;
  boxes(input?: unknown): Promise<unknown>;
  get(input: { boxId: string }): Promise<unknown>;
  update(input: { boxId: string; updateBoxRequest: unknown }): Promise<unknown>;
  fork(input: { boxId: string; forkRequest: unknown }): Promise<unknown>;
  create(input: { createBoxRequest: unknown }): Promise<unknown>;
  resume(input: { boxId: string; resumeRequest?: unknown }): Promise<unknown>;
  stop(input: { boxId: string }): Promise<unknown>;
  remove(input: { boxId: string }): Promise<unknown>;
  command(input: { boxId: string; commandRequest: unknown }): Promise<unknown>;
  getLatestBoxSnapshot(input: { boxId: string }): Promise<unknown>;
  writeFile(input: { boxId: string; fileWriteRequest: unknown }): Promise<unknown>;
}

export interface BoxClientOptions {
  /** Test/advanced override. Normal production calls read lazy config values. */
  apiKey?: string;
  baseUrl?: string;
  /** Adapter test seam; normal callers must not provide an SDK instance. */
  api?: BoxSdkApi;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new Error(`Box SDK returned an invalid ${field}`);
  return text;
}

function boxFromSdk(value: unknown): BoxInfo {
  const raw = record(value);
  const box: BoxInfo = {
    id: requiredString(raw.id, "box id"),
    state: requiredString(raw.state, "box state"),
  };
  const name = optionalString(raw.name);
  const createdAt = optionalDate(raw.createdAt);
  const updatedAt = optionalDate(raw.updatedAt);
  const snapshotCompletedAt = optionalDate(raw.snapshotCompletedAt);
  const lastSnapshotStatus = optionalString(raw.lastSnapshotStatus);
  if (name) box.name = name;
  if (createdAt) box.createdAt = createdAt;
  if (updatedAt) box.updatedAt = updatedAt;
  if (snapshotCompletedAt) box.snapshotCompletedAt = snapshotCompletedAt;
  if (lastSnapshotStatus) box.lastSnapshotStatus = lastSnapshotStatus;
  return box;
}

function boxFromEnvelope(value: unknown): BoxInfo {
  return boxFromSdk(record(value).box);
}

function actionFromSdk(value: unknown): BoxAction {
  const raw = record(value);
  return {
    id: requiredString(raw.id, "action id"),
    status: requiredString(raw.status, "action status"),
  };
}

function snapshotFromSdk(value: unknown): BoxSnapshot {
  const raw = record(value);
  const snapshot: BoxSnapshot = {
    id: requiredString(raw.id, "snapshot id"),
    status: requiredString(raw.status, "snapshot status"),
  };
  const createdAt = optionalDate(raw.createdAt);
  const completedAt = optionalDate(raw.completedAt);
  if (createdAt) snapshot.createdAt = createdAt;
  if (completedAt) snapshot.completedAt = completedAt;
  return snapshot;
}

/**
 * Create the production client. This function deliberately does not log its
 * configuration: apiKey is a control-plane secret and must never reach logs.
 */
export function makeBoxClient(options: BoxClientOptions = {}): BoxClient {
  const apiKey = options.apiKey ?? config.box.apiKey;
  const baseUrl = options.baseUrl ?? config.box.baseUrl ?? DEFAULT_BOX_BASE_URL;
  if (!apiKey && !options.api) throw new Error("BOX_API_KEY environment variable required");

  const api: BoxSdkApi =
    options.api ??
    (new BoxApi(
      new Configuration({
        basePath: baseUrl,
        accessToken: apiKey!,
      })
    ) as unknown as BoxSdkApi);

  return {
    async limits(): Promise<BoxLimits> {
      const raw = record(await api.limits());
      return {
        canStart: raw.canStart === true,
        activeBoxes: optionalNumber(raw.activeBoxes) ?? 0,
        maxActiveBoxes: optionalNumber(raw.maxActiveBoxes) ?? 0,
        ...(optionalString(raw.blockedReason) ? { blockedReason: optionalString(raw.blockedReason) } : {}),
        ...(optionalString(raw.startBlockedReason)
          ? { startBlockedReason: optionalString(raw.startBlockedReason) }
          : {}),
        ...(typeof raw.checkoutRequired === "boolean" ? { checkoutRequired: raw.checkoutRequired } : {}),
      };
    },

    async boxes(input = {}): Promise<BoxList> {
      const raw = record(await api.boxes(input));
      const rows = Array.isArray(raw.boxes) ? raw.boxes : [];
      const pageInfo = record(raw.pageInfo);
      const nextCursor = optionalString(pageInfo.nextCursor);
      return {
        boxes: rows.map(boxFromSdk),
        ...(nextCursor ? { nextCursor } : {}),
      };
    },

    async get(boxId: string): Promise<BoxInfo> {
      return boxFromEnvelope(await api.get({ boxId }));
    },

    async update(boxId, input): Promise<BoxInfo> {
      return boxFromEnvelope(await api.update({ boxId, updateBoxRequest: input }));
    },

    async fork(boxId, input): Promise<BoxAction> {
      return actionFromSdk(await api.fork({ boxId, forkRequest: input }));
    },

    async create(input): Promise<BoxInfo> {
      return boxFromEnvelope(await api.create({ createBoxRequest: input }));
    },

    async resume(boxId, input): Promise<BoxAction> {
      return actionFromSdk(await api.resume({ boxId, ...(input ? { resumeRequest: input } : {}) }));
    },

    async stop(boxId: string): Promise<BoxAction> {
      return actionFromSdk(await api.stop({ boxId }));
    },

    async remove(boxId: string): Promise<void> {
      await api.remove({ boxId });
    },

    async command(boxId, input): Promise<BoxCommandResult> {
      const raw = record(await api.command({ boxId, commandRequest: input }));
      return {
        success: raw.success === true,
        exitCode: typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : null,
        stdout: optionalString(raw.stdout) ?? "",
        stderr: optionalString(raw.stderr) ?? "",
        timedOut: raw.timedOut === true,
      };
    },

    async getLatestBoxSnapshot(boxId: string): Promise<BoxSnapshot | null> {
      const raw = record(await api.getLatestBoxSnapshot({ boxId }));
      return raw.snapshot == null ? null : snapshotFromSdk(raw.snapshot);
    },
    async writeFile(boxId, input): Promise<void> {
      await api.writeFile({ boxId, fileWriteRequest: input });
    },
  };
}
