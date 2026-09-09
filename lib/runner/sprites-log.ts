import { createLogger, type LogLevel } from "../worker/log";

const log = createLogger("sprites.lifecycle");
// Never spread provider responses, service environments, manifests, commands,
// lease tokens or Error objects into logs. Restrict even runtime callers to
// this primitive-field vocabulary (TypeScript alone cannot enforce that).
const keys = ["runId", "spriteName", "poolEntryId", "fingerprint", "baselineFingerprint",
  "checkpointId", "workerGeneration", "instanceId", "operationId", "serviceName",
  "phase", "outcome", "reason", "durationMs", "target", "total", "ready", "preparing",
  "maxSprites", "inFlight", "retryAt", "retryDelayMs", "attempt", "count", "reused",
  "revision", "baselineRevision", "hasTree", "hasReceipt", "errorKind", "httpStatus", "errorCode", "exitCode"] as const;
type Key = typeof keys[number];
export type SpriteLogFields = Partial<Record<Key, string | number | boolean | null | undefined>>;

export function spriteLog(event: string, fields: SpriteLogFields = {}, level: LogLevel = "info"): void {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string") safe[key] = value.slice(0, 256);
    else if (typeof value === "boolean" || value === null) safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  log[level](event, { event, ...safe });
}

/** Provider bodies and command stderr can contain bearer tokens and URLs. */
export function spriteErrorFields(error: unknown): SpriteLogFields {
  const e = error && typeof error === "object" ? error as { status?: unknown; code?: unknown; name?: unknown; exitCode?: unknown } : {};
  const fields: SpriteLogFields = { errorKind: "operation" };
  if (typeof e.status === "number" && Number.isFinite(e.status)) {
    fields.errorKind = "provider"; fields.httpStatus = e.status;
  } else if (e.name === "TimeoutError" || e.name === "AbortError") fields.errorKind = "timeout";
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOENT", "EACCES", "ENOSPC"].includes(String(e.code))) fields.errorCode = String(e.code);
  if (typeof e.exitCode === "number" && Number.isInteger(e.exitCode)) fields.exitCode = e.exitCode;
  return fields;
}

export async function logSpritePhase<T>(phase: string, fields: SpriteLogFields, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  spriteLog("sprites_phase_started", { ...fields, phase });
  try {
    const result = await fn();
    spriteLog("sprites_phase_completed", { ...fields, phase, outcome: "success", durationMs: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    spriteLog("sprites_phase_failed", { ...fields, phase, outcome: "error", durationMs: Math.round(performance.now() - started), ...spriteErrorFields(error) }, "warn");
    throw error;
  }
}

export function spriteWorkerLogContext(): SpriteLogFields {
  const positive = (value: string | undefined) => value && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : undefined;
  return { runId: positive(process.env.RUN_ID), workerGeneration: positive(process.env.TASK_ORCH_WORKER_GENERATION),
    spriteName: process.env.TASK_ORCH_SPRITE_NAME, instanceId: process.env.TASK_ORCH_WORKER_INSTANCE_ID };
}
