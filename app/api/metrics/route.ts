import { sql } from "drizzle-orm";

import { agentSessions, environments, runnerInstances } from "@/db/schema";
import { db } from "@/db";
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
