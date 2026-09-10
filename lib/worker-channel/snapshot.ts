import { dbTransport } from "../worker/db-transport";
import { enqueueUserInputTx, materializeAndClaimRunTurn } from "../run-inputs";
import { db } from "../../db";
import { and, eq, inArray } from "drizzle-orm";
import { agentMessages, runnerInstances, runInputs } from "../../db/schema";
import type {
  MessageSnapshot,
  PersonaSnapshot,
  PlanSnapshot,
  RepositorySnapshot,
  RunSnapshot,
  RunStart,
  TaskSnapshot,
} from "./protocol";
import { allowedServerTools } from "../worker/server-policy";

type SnapshotMode = RunStart["mode"];

function wire<T>(value: T): T {
  // Dates in Drizzle rows must become ISO strings before the snapshot is put
  // into a JSON envelope. JSON round-tripping also prevents a mutable DB row
  // from leaking into a queued durable command.
  return JSON.parse(JSON.stringify(value)) as T;
}

function pendingMessages(messages: Awaited<ReturnType<typeof dbTransport.listMessages>>): {
  transcript: MessageSnapshot[];
  pendingInput: MessageSnapshot[];
} {
  const lastAgentId = messages.reduce(
    (last, message) => (message.role === "agent" ? Math.max(last, message.id) : last),
    0
  );
  // "pendingInput" is user input that arrived AFTER a prior worker's last reply —
  // a follow-up to resume from. A fresh run has no agent turn yet, so its initial
  // user message(s) are the starting transcript, not trailing pending input; keep
  // them in the transcript so the snapshot carries the run's opening context.
  const pending =
    lastAgentId === 0
      ? []
      : messages.filter((message) => message.role === "user" && message.id > lastAgentId);
  const firstPendingId = pending[0]?.id;
  const transcriptRows = firstPendingId == null
    ? messages
    : messages.filter((message) => message.id < firstPendingId);
  return {
    transcript: wire(transcriptRows) as unknown as MessageSnapshot[],
    pendingInput: wire(pending) as unknown as MessageSnapshot[],
  };
}

async function ambientMemory(runId: number): Promise<string> {
  try {
    const result = await dbTransport.callTool(runId, "memory__load", {}, { author: "worker" });
    const text = result.content.find((block) => block.type === "text");
    if (!result.isError && text?.type === "text") {
      const parsed = JSON.parse(text.text) as { blocks?: unknown };
      if (Array.isArray(parsed.blocks)) return JSON.stringify(parsed.blocks);
    }
  } catch {
    // A memory read is additive context. A temporarily unavailable memory
    // index must not prevent a worker from starting from its authoritative run
    // snapshot.
  }
  return "";
}

/**
 * Build the complete control-plane-owned bootstrap bundle. This is intentionally
 * the only place that assembles worker bootstrap context; the worker receives a
 * self-contained command and never needs to query Postgres for it.
 */
export async function buildRunStart(
  runId: number,
  mode?: SnapshotMode
): Promise<RunStart> {
  const run = await dbTransport.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  // Fresh vs resume is decided here (the builder owns it): a run that already
  // carries a backend SDK session id is resuming a prior turn; otherwise it is a
  // fresh start. An explicit mode argument overrides the inference.
  const resolvedMode: SnapshotMode = mode ?? (run.sdkSessionId ? "resume" : "start");

  const [initialMessages, task, persona, repository] = await Promise.all([
    dbTransport.listMessages(runId),
    run.taskId ? dbTransport.getTask(run.taskId) : Promise.resolve(null),
    dbTransport.getPersona(run.personaId ?? "implementor"),
    dbTransport.resolveRepo(runId),
  ]);
  if (!persona) throw new Error(`Persona '${run.personaId ?? "implementor"}' not found`);

  const planId = run.planId ?? task?.planId ?? null;
  const plan = planId ? await dbTransport.getPlan(planId) : null;
  const v2 = (run.deliveryVersion ?? 1) >= 2;
  const legacyDigest = v2 ? null : await dbTransport.claimInboxDigest(runId);
  const generationRow = v2 ? (await db.select({ generation: runnerInstances.workerGeneration }).from(runnerInstances).where(eq(runnerInstances.runId, runId)).limit(1))[0] : null;
  let durableTurn = v2 ? await materializeAndClaimRunTurn(runId, generationRow?.generation ?? 1) : null;
  // Materialization is the durable source of truth. Keep inboxDigest null for
  // v2 workers; claiming a legacy digest here could acknowledge an event
  // without a model turn receipt.
  const [memoryContext, toolNames] = await Promise.all([
    ambientMemory(runId),
    allowedServerTools(run.toolsProfile || persona.toolsProfile),
  ]);
  let messages = durableTurn ? await dbTransport.listMessages(runId) : initialMessages;
  let { transcript: rawTranscript, pendingInput } = pendingMessages(messages);
  let manifestMessageIds = new Set((durableTurn?.inputs ?? []).map((input) => input.messageId));
  let transcript = manifestMessageIds.size
    ? rawTranscript.filter((message) => !manifestMessageIds.has(message.id))
    : rawTranscript;
  let durablePendingInput = durableTurn
    ? messages.filter((message) => manifestMessageIds.has(message.id)).map((message) => wire(message) as unknown as MessageSnapshot)
    : pendingInput;

  // Goal-synthesized kickoff prompt (fresh starts only — a resume rides the
  // backend session's prior context plus the inbox digest). This is the
  // channel-native home of the worker's goal branches:
  //   <execute>  → the plan-orchestration scaffold (buildExecutePrompt)
  //   <implement>→ the task prompt (buildImplementPrompt)
  //   free-form  → the goal text verbatim
  // An operator initialPrompt is already persisted as the first user message
  // (launchDetached) and rides `pendingInput`; the worker appends it AFTER
  // this scaffold, mirroring the legacy "operator instructions" section.
  let kickoffPrompt: string | undefined;
  if (resolvedMode === "start") {
    const goal = run.goal ?? "";
    if (goal === "<execute>" && plan) {
      const { buildExecutePrompt } = await import("../run-templates");
      kickoffPrompt = buildExecutePrompt(plan, await dbTransport.listTasks({ planId: plan.id }));
    } else if (goal === "<implement>" && task) {
      const { buildImplementPrompt } = await import("../run-templates");
      kickoffPrompt = await buildImplementPrompt(task, { autoMerge: run.autoMerge !== false, baseBranch: run.baseBranch });
    } else if (goal && !goal.startsWith("<")) {
      kickoffPrompt = goal;
    }
  }
  if (v2 && !durableTurn && !initialMessages.length && !kickoffPrompt) kickoffPrompt = "Continue this run using its goal and conversation context.";
  // A fresh v2 run must always have a durable first input. Persist the
  // synthesized kickoff as a user message so it receives the same receipt and
  // replay guarantees as every later input.
  if (v2 && !durableTurn && kickoffPrompt?.trim()) {
    await db.transaction(async (tx) => {
      const inserted = await tx.insert(agentMessages).values({ runId, role: "user", content: JSON.stringify([{ type: "text", text: kickoffPrompt }]), idempotencyKey: `durable-kickoff:${runId}` }).onConflictDoNothing().returning({ id: agentMessages.id });
      const row = inserted[0] ?? (await tx.select({ id: agentMessages.id }).from(agentMessages).where(eq(agentMessages.idempotencyKey, `durable-kickoff:${runId}`)).limit(1))[0];
      if (row) await enqueueUserInputTx(tx, runId, row.id);
    });
    durableTurn = await materializeAndClaimRunTurn(runId, generationRow?.generation ?? 1);
    kickoffPrompt = undefined; // Already represented by the durable kickoff input.
    messages = await dbTransport.listMessages(runId);
    ({ transcript: rawTranscript, pendingInput } = pendingMessages(messages));
    manifestMessageIds = new Set((durableTurn?.inputs ?? []).map((input) => input.messageId));
    transcript = manifestMessageIds.size ? rawTranscript.filter((message) => !manifestMessageIds.has(message.id)) : rawTranscript;
    durablePendingInput = messages.filter((message) => manifestMessageIds.has(message.id)).map((message) => wire(message) as unknown as MessageSnapshot);
  }
  if (v2 && durableTurn) {
    const unresolved = await db.select({ messageId: runInputs.messageId }).from(runInputs)
      .where(and(eq(runInputs.runId, runId), inArray(runInputs.status, ["pending", "assigned", "cancelled"])));
    const excluded = new Set(unresolved.map(input => input.messageId));
    messages = await dbTransport.listMessages(runId);
    transcript = wire(messages.filter(message => !excluded.has(message.id))) as unknown as MessageSnapshot[];
    const byId = new Map(messages.map(message => [message.id, message]));
    durablePendingInput = durableTurn.inputs.map(input => {
      const message = byId.get(input.messageId);
      if (!message) throw new Error(`Missing input message ${input.messageId}`);
      return wire(message) as unknown as MessageSnapshot;
    });
  }
  const deadline = run.budgetMaxSeconds == null
    ? null
    : new Date(run.startedAt.getTime() + run.budgetMaxSeconds * 1000).toISOString();

  return {
    mode: resolvedMode,
    run: wire(run) as unknown as RunSnapshot,
    task: task ? (wire(task) as unknown as TaskSnapshot) : null,
    plan: plan ? (wire(plan) as unknown as PlanSnapshot) : null,
    persona: wire(persona) as unknown as PersonaSnapshot,
    repository: repository
      ? (wire(repository) as unknown as RepositorySnapshot)
      : ({ id: "none" } as RepositorySnapshot),
    transcript,
    inboxDigest: legacyDigest,
    memoryContext,
    pendingInput: durablePendingInput,
    ...(durableTurn ? {
      turnId: durableTurn.id,
      inputManifest: durableTurn.inputs.map((input) => ({ id: input.id, inputSeq: input.inputSeq, messageId: input.messageId, kind: input.kind })),
    } : {}),
    policy: {
      allowedTools: toolNames,
      maxTurns: run.budgetMaxTurns,
      deadline,
    },
    ...(kickoffPrompt !== undefined ? { kickoffPrompt } : {}),
  };
}
