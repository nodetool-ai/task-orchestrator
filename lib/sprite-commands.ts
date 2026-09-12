import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import type { AppApiContext } from "./app-api/types";
import { spriteCaller, withOwnedSprite, type SpriteRunTarget } from "./sprite-access";
import { makeSpritesClient } from "./runner/sprites-client";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const commandSchema = z.object({
  runId: z.number().int().positive(), generation: z.number().int().positive(),
  command: z.string().min(1).max(64_000), directory: z.string().min(1).max(4096).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).default(600),
  commandId: z.string().uuid(),
});
const jobPath = (runId: number, generation: number, commandId: string) =>
  `/var/tmp/task-orch-codeact/r${z.number().int().positive().parse(runId)}/g${z.number().int().positive().parse(generation)}/${z.string().uuid().parse(commandId)}`;

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

export async function checkpointRun(ctx: AppApiContext, target: SpriteRunTarget & { comment?: string }) {
  return withOwnedSprite(ctx, target, (runner) => providerCall(() => makeSpritesClient().checkpoint(runner.spriteName!, target.comment)));
}
