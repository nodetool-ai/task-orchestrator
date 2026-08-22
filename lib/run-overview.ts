// Read path for the unified /runs index: every run (chats included — a chat
// is a run with goal '<chat>'), enriched with the repo/task/plan names the
// rows reference and serialized to the client-safe RunIndexRow shape.
// Shared by the server-rendered first paint (app/runs/page.tsx) and the
// polling endpoint (GET /api/runs/overview) so both produce identical rows.

import { db } from "@/db";
import { personas } from "@/db/schema";
import * as repo from "./repo";
import { pendingOwnerCounts } from "./inbox";
import { listRuns } from "./runs";
import type { RunIndexRow } from "./run-index";

export async function getRunOverview(): Promise<RunIndexRow[]> {
  const [runs, repos, tasks, plans, personaRows, pendingEvents] = await Promise.all([
    listRuns(),
    repo.listRepositories(),
    repo.listTasks(),
    repo.listPlans(),
    // One query for the whole (small) persona table, joined in memory like the
    // repo/task/plan names above — never one lookup per run.
    db.select({ id: personas.id, name: personas.name }).from(personas),
    // Agent-event visibility (docs/agent-events.md §11): "N queued" badges.
    // Never let an inbox hiccup take down the whole index.
    pendingOwnerCounts().catch(() => new Map<number, number>()),
  ]);
  const repoNames = new Map(repos.map((r) => [r.id, r.name]));
  const taskTitles = new Map(tasks.map((t) => [t.id, t.title]));
  const planTitles = new Map(plans.map((p) => [p.id, p.title]));
  const personaNames = new Map(personaRows.map((p) => [p.id, p.name]));

  return runs.map((r) => ({
    id: r.id,
    goal: r.goal,
    status: r.status,
    origin: r.origin,
    title: r.title,
    taskId: r.taskId,
    taskTitle: r.taskId ? taskTitles.get(r.taskId) ?? null : null,
    planId: r.planId,
    planTitle: r.planId ? planTitles.get(r.planId) ?? null : null,
    repoId: r.repoId,
    repoName: r.repoId ? repoNames.get(r.repoId) ?? null : null,
    personaId: r.personaId,
    personaName: r.personaId ? personaNames.get(r.personaId) ?? null : null,
    parentRunId: r.parentRunId,
    prUrl: r.prUrl,
    model: r.model,
    totalCostUsd: r.totalCostUsd,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    parkReason: r.parkReason,
    pendingReason: r.pendingReason,
    pendingEvents: pendingEvents.get(r.id) ?? 0,
  }));
}
