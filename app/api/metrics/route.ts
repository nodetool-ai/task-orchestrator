import { sql } from "drizzle-orm";

import { agentSessions, runnerInstances } from "@/db/schema";
import { db } from "@/db";
import {
  recordMetricsRefreshError,
  setActiveRuns,
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

  setActiveRuns(runRows);
  setRunnerInstances(runnerRows);
}
