import { dbTransport } from "../worker/db-transport";
import type {
  MessageSnapshot,
  PersonaSnapshot,
  PlanSnapshot,
  RepositorySnapshot,
  RunSnapshot,
  RunStart,
  TaskSnapshot,
} from "./protocol";

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
  const pending = messages.filter((message) => message.role === "user" && message.id > lastAgentId);
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

async function allowedTools(profile: string): Promise<string[]> {
  const names = new Set<string>();
  const [events, memory, orchestrator, planning, spawn] = await Promise.all([
    import("../extensions/events"),
    import("../extensions/persona-memory"),
    import("../orchestrator-tools"),
    import("../extensions/planning"),
    import("../extensions/spawn"),
  ]);
  for (const tool of [...events.EVENT_TOOLS, ...memory.MEMORY_TOOLS]) {
    if (tool.name !== "memory__load") names.add(tool.name);
  }
  const profiles = new Set(profile.split(",").map((value) => value.trim()).filter(Boolean));
  if (profiles.has("orchestrator")) for (const tool of orchestrator.ORCHESTRATOR_TOOLS) names.add(tool.name);
  if (profiles.has("planning")) for (const tool of planning.PLANNING_TOOLS) names.add(tool.name);
  if (profiles.has("spawn")) for (const tool of spawn.SPAWN_TOOLS) names.add(tool.name);
  return [...names].sort();
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

  const [messages, task, persona, repository] = await Promise.all([
    dbTransport.listMessages(runId),
    run.taskId ? dbTransport.getTask(run.taskId) : Promise.resolve(null),
    dbTransport.getPersona(run.personaId ?? "implementor"),
    dbTransport.resolveRepo(runId),
  ]);
  if (!persona) throw new Error(`Persona '${run.personaId ?? "implementor"}' not found`);

  const planId = run.planId ?? task?.planId ?? null;
  const plan = planId ? await dbTransport.getPlan(planId) : null;
  const [inboxDigest, memoryContext, toolNames] = await Promise.all([
    dbTransport.claimInboxDigest(runId),
    ambientMemory(runId),
    allowedTools(run.toolsProfile || persona.toolsProfile),
  ]);
  const { transcript, pendingInput } = pendingMessages(messages);
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
    inboxDigest,
    memoryContext,
    pendingInput,
    policy: {
      allowedTools: toolNames,
      maxTurns: run.budgetMaxTurns,
      deadline,
    },
  };
}
