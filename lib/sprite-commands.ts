import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { agentEvents, agentSessions, runnerInstances } from "../db/schema";
import type { AppApiContext } from "./app-api/types";
import { spriteCaller, withOwnedSprite, type SpriteRunTarget } from "./sprite-access";
import { makeSpritesClient, SPRITE_CHECKPOINT_TIMEOUT_MS, type SpriteCheckpoint } from "./runner/sprites-client";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const commandSchema = z.object({
  runId: z.number().int().positive(), generation: z.number().int().positive(),
  command: z.string().min(1).max(64_000), directory: z.string().min(1).max(4096).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).default(600),
  commandId: z.string().uuid(),
});
const jobPath = (runId: number, generation: number, commandId: string) =>
  `/var/tmp/task-orch-codeact/r${z.number().int().positive().parse(runId)}/g${z.number().int().positive().parse(generation)}/${z.string().uuid().parse(commandId)}`;

const checkpointSchema = z.object({
  runId: z.number().int().positive(),
  generation: z.number().int().positive(),
  operationId: z.string().uuid(),
  comment: z.string().max(1000).optional(),
});
const CHECKPOINT_EVENT_TYPE = "sprite_checkpoint_operation";
const CHECKPOINT_OPERATION_STALE_MS = SPRITE_CHECKPOINT_TIMEOUT_MS + 60_000;
type CheckpointOperationStatus = "submitted" | "running" | "completed" | "failed" | "unknown";
type CheckpointOperation = {
  runId: number;
  generation: number;
  operationId: string;
  status: CheckpointOperationStatus;
  comment?: string;
  providerComment: string;
  checkpointId?: string;
  error?: string;
  retryable?: boolean;
  createdAt?: Date;
};

declare global {
  // eslint-disable-next-line no-var
  var __taskOrchSpriteCheckpointJobs: Map<string, Promise<void>> | undefined;
}
const checkpointJobs = globalThis.__taskOrchSpriteCheckpointJobs ??= new Map<string, Promise<void>>();

const checkpointKey = (input: Pick<CheckpointOperation, "runId" | "generation" | "operationId">) =>
  `${input.runId}:${input.generation}:${input.operationId}`;
function providerCheckpointComment(input: { operationId: string; comment?: string }): string {
  const suffix = ` [task-orch:${input.operationId}]`;
  const prefix = (input.comment?.trim() || "Personal recovery checkpoint").slice(0, 1000 - suffix.length);
  return prefix + suffix;
}
function redactProviderError(value: string): string {
  return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_TOKEN]")
    .replace(/((?:authorization|proxy-authorization)\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key)[\"']?\s*[:=]\s*[\"']?)[^\s,}\"]+/gi, "$1[REDACTED]")
    .slice(0, 2000);
}
function providerErrorDetail(error: unknown): string {
  const e = error && typeof error === "object"
    ? error as { message?: unknown; status?: unknown; code?: unknown }
    : {};
  const detail = typeof e.message === "string" ? e.message : String(error);
  const labels = [
    typeof e.status === "number" ? `HTTP ${e.status}` : "",
    typeof e.code === "string" ? e.code : "",
  ].filter(Boolean);
  return redactProviderError(`${labels.length ? labels.join(" ") + ": " : ""}${detail}`);
}
function decodeCheckpointEvent(row: { payload: string; createdAt: Date }): CheckpointOperation | null {
  try {
    const parsed = JSON.parse(row.payload) as CheckpointOperation;
    return parsed && typeof parsed.operationId === "string" && typeof parsed.status === "string"
      ? { ...parsed, createdAt: row.createdAt }
      : null;
  } catch { return null; }
}
async function latestCheckpointOperation(runId: number, operationId: string): Promise<CheckpointOperation | null> {
  const [row] = await db.select({ payload: agentEvents.payload, createdAt: agentEvents.createdAt })
    .from(agentEvents).where(and(
      eq(agentEvents.sessionId, runId),
      eq(agentEvents.type, CHECKPOINT_EVENT_TYPE),
      sql`${agentEvents.payload}::jsonb ->> 'operationId' = ${operationId}`,
    )).orderBy(desc(agentEvents.id)).limit(1);
  return row ? decodeCheckpointEvent(row) : null;
}
async function appendCheckpointOperation(operation: CheckpointOperation): Promise<void> {
  const { createdAt: _, ...payload } = operation;
  await db.insert(agentEvents).values({
    sessionId: operation.runId,
    type: CHECKPOINT_EVENT_TYPE,
    payload: JSON.stringify(payload),
  });
}
async function assertOwnedRun(ctx: AppApiContext, runId: number): Promise<void> {
  const owner = await spriteCaller(ctx);
  const [run] = await db.select({ id: agentSessions.id }).from(agentSessions).where(and(
    eq(agentSessions.id, runId), eq(agentSessions.userId, owner.userId),
  ));
  if (!run) throw new Error("Sprite run not found or not owned by the caller");
}

async function providerCall<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new Error("Sprite request did not complete. Its remote outcome may be unknown; inspect command status before retrying a mutation."); }
}

export async function listAgentSprites(ctx: AppApiContext) {
  const { userId } = await spriteCaller(ctx);
  return db.select({ runId: runnerInstances.runId, generation: runnerInstances.workerGeneration,
    state: runnerInstances.state, generationState: runnerInstances.generationState,
    repoId: agentSessions.repoId, directory: runnerInstances.repoPath })
    .from(runnerInstances).innerJoin(agentSessions, eq(agentSessions.id, runnerInstances.runId))
    .where(and(eq(agentSessions.userId, userId), eq(runnerInstances.provider, "sprites"),
      isNotNull(runnerInstances.spriteName), inArray(runnerInstances.state, ["running", "suspended"])));
}

/** Detached and time-bounded inside the VM, independent of CodeAct/HTTP idle
 * deadlines. A caller-supplied UUID makes launch retries idempotent. Files are
 * run-private scratch data and never promoted to the warm pool. */
export async function startSpriteCommand(ctx: AppApiContext, raw: unknown) {
  const input = commandSchema.parse(raw);
  const commandId = input.commandId;
  const path = jobPath(input.runId, input.generation, commandId);
  return withOwnedSprite(ctx, input, async (runner) => {
    const digest = createHash("sha256").update(JSON.stringify([input.command, input.directory ?? runner.repoPath, input.timeoutSeconds])).digest("hex");
    const script = `#!/bin/sh\ncd ${quote(input.directory ?? runner.repoPath)} || exit 125\nexec timeout --signal=TERM --kill-after=5s ${input.timeoutSeconds}s sh -c ${quote(input.command)}\n`;
    const wrapper = `ulimit -f 20480\nsh ${quote(path + "/command")} >${quote(path + "/stdout")} 2>${quote(path + "/stderr")}\nresult=$?\nprintf '%s' "$result" >${quote(path + "/exit.tmp")}\nmv ${quote(path + "/exit.tmp")} ${quote(path + "/exit")}\n`;
    const launch = `umask 077\nmkdir -p ${quote(path.substring(0, path.lastIndexOf("/")))} || exit 125\nif mkdir ${quote(path)} 2>/dev/null; then\nprintf '%s' ${quote(digest)} >${quote(path + "/digest")} || exit 125\nprintf '%s' ${quote(script)} >${quote(path + "/command")} || exit 125\nprintf '%s' ${quote(wrapper)} >${quote(path + "/wrapper")} || exit 125\nnohup sh ${quote(path + "/wrapper")} </dev/null >/dev/null 2>&1 &\nprintf '%s' "$!" >${quote(path + "/pid")}\nelse\n[ -f ${quote(path + "/digest")} ] && [ "$(cat ${quote(path + "/digest")})" = ${quote(digest)} ] || exit 73\nfi`;
    const result = await providerCall(() => makeSpritesClient().exec(runner.spriteName!, { cmd: launch, maxOutputBytes: 64_000, timeoutMs: 10_000 }));
    if (result.exitCode === 73) throw new Error("Command ID is already reserved for different input or an incomplete launch; inspect its status");
    if (result.exitCode !== 0) throw new Error("Remote command launch failed; inspect command status before retrying");
    return { runId: input.runId, generation: input.generation, commandId, status: "submitted", timeoutSeconds: input.timeoutSeconds };
  });
}

export async function spriteCommandStatus(ctx: AppApiContext, input: SpriteRunTarget & { commandId: string }) {
  const path = jobPath(input.runId, input.generation, input.commandId);
  return withOwnedSprite(ctx, input, async (runner) => {
    // JSON construction stays in the control plane. Only bounded file bytes
    // cross the provider connection; stdout cannot grow control-plane memory.
    const result = await providerCall(() => makeSpritesClient().exec(runner.spriteName!, {
      cmd: `if [ ! -d ${quote(path)} ]; then printf missing; elif [ -f ${quote(path + "/exit")} ]; then printf 'exited '; head -c 8 ${quote(path + "/exit")}; elif [ -f ${quote(path + "/pid")} ] && kill -0 "$(cat ${quote(path + "/pid")})" 2>/dev/null; then printf running; else printf unknown; fi\nprintf '\\n'\ntail -c 16000 ${quote(path + "/stdout")} 2>/dev/null\ntail -c 16000 ${quote(path + "/stderr")} >&2 2>/dev/null\ntrue`, maxOutputBytes: 64_000, timeoutMs: 10_000,
    }));
    const newline = result.stdout.indexOf("\n");
    const status = result.stdout.slice(0, newline);
    const exit = /^exited (\d+)$/.exec(status);
    return { ...input, status: exit ? "exited" : ["running", "missing"].includes(status) ? status : "unknown",
      exitCode: exit ? Number(exit[1]) : null, stdout: result.stdout.slice(newline + 1), stderr: result.stderr,
      output: "Last 16000 bytes per stream; files are capped at 10 MiB. A missing/unknown status is not proof that a command never ran." };
  });
}

export async function execSpriteCommand(ctx: AppApiContext, raw: unknown) {
  const input = commandSchema.extend({ timeoutSeconds: z.number().int().min(1).max(15).default(10) }).parse(raw);
  // Use the same durable job path, so an HTTP timeout cannot make a retry
  // silently execute the command twice when commandId was supplied.
  const job = await startSpriteCommand(ctx, input);
  return withOwnedSprite(ctx, input, async (runner) => {
    const path = jobPath(input.runId, input.generation, job.commandId);
    await providerCall(() => makeSpritesClient().exec(runner.spriteName!, {
      cmd: `n=0; while [ ! -f ${quote(path + "/exit")} ] && [ "$n" -lt ${input.timeoutSeconds} ]; do sleep 1; n=$((n+1)); done`, maxOutputBytes: 64_000, timeoutMs: (input.timeoutSeconds + 2) * 1000,
    }));
    return job;
  }).then((job) => spriteCommandStatus(ctx, job));
}

export async function listRunCheckpoints(ctx: AppApiContext, target: SpriteRunTarget) {
  return withOwnedSprite(ctx, target, (runner) => providerCall(() => makeSpritesClient().listCheckpoints(runner.spriteName!)));
}

/** Submit a long-running provider checkpoint without holding the MCP request or
 * runner-row lock open. operationId is both the idempotency key and part of the
 * provider comment, so a retry after process loss can discover the result. */
export async function checkpointRun(ctx: AppApiContext, raw: unknown) {
  const input = checkpointSchema.parse(raw);
  const spriteName = await withOwnedSprite(ctx, input, async (runner) => runner.spriteName!);
  const providerComment = providerCheckpointComment(input);
  const operation: CheckpointOperation = { ...input, providerComment, status: "submitted" };
  const key = checkpointKey(input);

  const reserved = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sprite-checkpoint:${key}`}))`);
    const [row] = await tx.select({ payload: agentEvents.payload, createdAt: agentEvents.createdAt })
      .from(agentEvents).where(and(
        eq(agentEvents.sessionId, input.runId),
        eq(agentEvents.type, CHECKPOINT_EVENT_TYPE),
        sql`${agentEvents.payload}::jsonb ->> 'operationId' = ${input.operationId}`,
      )).orderBy(desc(agentEvents.id)).limit(1);
    const previous = row ? decodeCheckpointEvent(row) : null;
    if (previous && previous.providerComment !== providerComment) {
      throw new Error("Checkpoint operation ID is already reserved for a different comment");
    }
    const stillRunning = previous && ["submitted", "running"].includes(previous.status)
      && Date.now() - row.createdAt.getTime() <= CHECKPOINT_OPERATION_STALE_MS;
    if (previous?.status === "completed" || stillRunning) return { launch: false, operation: previous };
    await tx.insert(agentEvents).values({ sessionId: input.runId, type: CHECKPOINT_EVENT_TYPE,
      payload: JSON.stringify(operation) });
    return { launch: true, operation };
  });
  if (!reserved.launch || checkpointJobs.has(key)) return reserved.operation;

  const job = (async () => {
    await appendCheckpointOperation({ ...operation, status: "running" });
    try {
      const client = makeSpritesClient();
      const existing = (await client.listCheckpoints(spriteName))
        .filter((checkpoint) => checkpoint.comment === providerComment)
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
      const checkpoint: SpriteCheckpoint = existing ?? await client.checkpoint(spriteName, providerComment);
      await appendCheckpointOperation({ ...operation, status: "completed", checkpointId: checkpoint.id });
    } catch (error) {
      await appendCheckpointOperation({ ...operation, status: "failed", error: providerErrorDetail(error), retryable: true });
    }
  })().finally(() => checkpointJobs.delete(key));
  checkpointJobs.set(key, job);
  void job.catch(() => {});
  return operation;
}

/** Inspect a checkpoint operation even if its Sprite generation has since been
 * replaced. Ownership is still checked against the persisted run. */
export async function checkpointRunStatus(ctx: AppApiContext, raw: unknown) {
  const input = checkpointSchema.pick({ runId: true, generation: true, operationId: true }).parse(raw);
  await assertOwnedRun(ctx, input.runId);
  const operation = await latestCheckpointOperation(input.runId, input.operationId);
  if (!operation || operation.generation !== input.generation) {
    return { ...input, status: "unknown" as const, retryable: true,
      error: "Checkpoint operation was not found for this run generation." };
  }
  if (["submitted", "running"].includes(operation.status)
      && operation.createdAt && Date.now() - operation.createdAt.getTime() > CHECKPOINT_OPERATION_STALE_MS) {
    return { ...operation, status: "unknown" as const, retryable: true,
      error: "Checkpoint completion was not recorded before the operation deadline; retry with the same operation ID." };
  }
  return operation;
}
