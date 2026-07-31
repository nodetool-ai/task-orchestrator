import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import {
  agentSessions,
  channelThreads,
  environments,
  inboxEvents,
  runnerInstances,
} from "@/db/schema";
import { db } from "@/db";
import { CONTROL_TYPES } from "@/lib/inbox";
import {
  STALE_PENDING_MINUTES,
  setCreationShare,
  setStalePendingEvents,
} from "@/lib/pipe/metrics";
import {
  recordMetricsRefreshError,
  setActiveRuns,
  setEnvironments,
  setRunnerInstances,
  telemetry,
} from "@/lib/runner/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await refreshDbBackedGauges();
  } catch (err) {
    recordMetricsRefreshError("db_gauges", err);
  }
  // The messaging gauges are refreshed separately: they are a newer, chattier
  // pair of queries, and a failure there must not cost the operator the runner
  // gauges above (or vice versa).
  try {
    await refreshPipeGauges();
  } catch (err) {
    recordMetricsRefreshError("pipe_gauges", err);
  }
  const registry = telemetry().registry;
  return new Response(await registry.metrics(), {
    headers: {
      "Content-Type": registry.contentType,
      "Cache-Control": "no-store",
    },
  });
}

async function refreshDbBackedGauges(): Promise<void> {
  const runRows = await db
    .select({
      status: agentSessions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(agentSessions)
    .groupBy(agentSessions.status);

  const runnerRows = await db
    .select({
      provider: runnerInstances.provider,
      state: runnerInstances.state,
      count: sql<number>`count(*)::int`,
    })
    .from(runnerInstances)
    .groupBy(runnerInstances.provider, runnerInstances.state);

  const environmentRows = await db
    .select({
      provider: environments.provider,
      state: environments.state,
      count: sql<number>`count(*)::int`,
    })
    .from(environments)
    .groupBy(environments.provider, environments.state);

  setActiveRuns(runRows);
  setRunnerInstances(runnerRows);
  setEnvironments(environmentRows);
}

/**
 * The two messaging metrics (PRD §11) that are properties of the DATABASE
 * rather than of a process, so they are computed here — where the scrape
 * happens — instead of in the pipe process that would otherwise own them:
 *
 *  1. CHANNEL SHARE. A run is "messaging"-created when it IS a persona
 *     conversation (its id is mapped in channel_threads) or when a persona
 *     conversation spawned it (its parent is). Everything else is "web".
 *     Plans and tasks carry no creator column, so their share is NOT derivable
 *     without a schema change — deliberately not reported rather than guessed.
 *  2. HEALTH. Pending inbox events on a MAPPED conversation that nothing has
 *     drained for STALE_PENDING_MINUTES. Since M5 the control plane defers
 *     those wakes to the pipe, so a growing number here means exactly one
 *     thing: the pipe is not running.
 */
async function refreshPipeGauges(): Promise<void> {
  const mappedRuns = sql`(select run_id from channel_threads)`;
  const shareRows = await db
    .select({
      source: sql<string>`case when ${agentSessions.id} in ${mappedRuns}
        or ${agentSessions.parentRunId} in ${mappedRuns} then 'messaging' else 'web' end`,
      count: sql<number>`count(*)::int`,
    })
    .from(agentSessions)
    .groupBy(sql`1`);

  const cutoff = new Date(Date.now() - STALE_PENDING_MINUTES * 60_000);
  const staleRows = await db
    .select({
      persona: channelThreads.personaId,
      count: sql<number>`count(*)::int`,
    })
    .from(inboxEvents)
    .innerJoin(channelThreads, eq(channelThreads.runId, inboxEvents.targetRunId))
    .where(
      and(
        eq(inboxEvents.status, "pending"),
        // Same filter the pipe's own wake check uses (lib/inbox.ts
        // hasPendingInboxEvents), so the gauge counts exactly the events whose
        // absence of progress means the pipe is not doing its job.
        inArray(inboxEvents.audience, ["owner", "supervisor"]),
        notInArray(inboxEvents.type, [...CONTROL_TYPES]),
        lt(inboxEvents.createdAt, cutoff)
      )
    )
    .groupBy(channelThreads.personaId);

  setCreationShare(shareRows.map((r) => ({ entity: "run", source: r.source, count: r.count })));
  setStalePendingEvents(staleRows);
}
