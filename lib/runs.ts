// Unified runs lister. Since migration 0009, both task-derived agent sessions
// and chat conversations live in agent_runs. This module is the read path
// for the /runs UI — it returns every row regardless of origin, plus a
// helper to resolve a legacy chat id (the old chats.id) to the new run id
// for /chat/[id] redirects.

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { agentSessions } from "@/db/schema";

export type RunOrigin = "task" | "chat";

// We deliberately widen status to string here. SessionStatus in lib/types
// covers task-derived runs, but chat-derived runs use 'idle' which isn't
// in that union. The /runs UI groups statuses into Active/Idle/Closed so
// it doesn't need a closed enum.
export interface RunRow {
  id: number;
  status: string;
  origin: RunOrigin;
  taskId: string | null;
  repoId: string | null;
  title: string | null;
  model: string | null;
  prUrl: string | null;
  error: string | null;
  totalCostUsd: number | null;
  legacyChatId: number | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface RunFilters {
  repoId?: string;
  taskId?: string;
}

export function listRuns(filters: RunFilters = {}): RunRow[] {
  const wheres = [];
  if (filters.repoId) wheres.push(eq(agentSessions.repoId, filters.repoId));
  if (filters.taskId) wheres.push(eq(agentSessions.taskId, filters.taskId));
  const where = wheres.length === 0 ? undefined : wheres.length === 1 ? wheres[0] : and(...wheres);
  const rows = db
    .select()
    .from(agentSessions)
    .where(where)
    .orderBy(desc(agentSessions.startedAt))
    .all();
  return rows.map(hydrate);
}

// Lookup any run by id, regardless of whether it's task-derived or
// chat-derived. lib/agent.getSession() filters to task-derived only and
// lib/chat.getChat() filters to chat-derived only; this is the un-filtered
// view for the /runs/[id] dispatcher.
export function getRun(id: number): RunRow | null {
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  return row ? hydrate(row) : null;
}

// Resolve a legacy chats.id (from before migration 0009) to the new
// agent_runs.id, for /chat/[id] → /runs/[id] redirects.
export function resolveLegacyChatId(chatId: number): number | null {
  const row = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.legacyChatId, chatId), isNotNull(agentSessions.legacyChatId)))
    .get();
  return row?.id ?? null;
}

// Group key for the /runs UI. Order of buckets is: Active (live work),
// Idle (chat runs and queued task runs waiting on a worker), Closed.
export type RunGroup = "active" | "idle" | "closed";

const ACTIVE_STATUSES = new Set<string>([
  "preparing",
  "running",
  "pushing",
  "opening_pr",
]);
const IDLE_STATUSES = new Set<string>(["pending", "idle"]);
const CLOSED_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);

export function groupForStatus(status: string): RunGroup {
  if (ACTIVE_STATUSES.has(status)) return "active";
  if (IDLE_STATUSES.has(status)) return "idle";
  if (CLOSED_STATUSES.has(status)) return "closed";
  // Unknown statuses fall into Idle so they're still discoverable rather
  // than silently dropped.
  return "idle";
}

export const RUN_GROUPS: readonly RunGroup[] = ["active", "idle", "closed"] as const;

export const RUN_GROUP_LABEL: Record<RunGroup, string> = {
  active: "Active",
  idle: "Idle",
  closed: "Closed",
};

function hydrate(row: typeof agentSessions.$inferSelect): RunRow {
  const origin: RunOrigin =
    row.taskId !== null ? "task" : "chat";
  return {
    id: row.id,
    status: row.status,
    origin,
    taskId: row.taskId,
    repoId: row.repoId,
    title: row.title,
    model: row.model,
    prUrl: row.prUrl,
    error: row.error,
    totalCostUsd: row.totalCostUsd,
    legacyChatId: row.legacyChatId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}
