import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import * as runsLib from "@/lib/runs";
import { auth } from "@/auth";
import { errorResponse } from "@/lib/api";
import { bucketFor, dedupeLiveByTask, LIVE_BUCKET_PRIORITY } from "@/lib/run-buckets";
import type { LiveSessionItem } from "@/components/pi/live-sidebar";

export const dynamic = "force-dynamic";

function shortRunId(id: number, startedAt: Date): string {
  const y = startedAt.getFullYear();
  const m = String(startedAt.getMonth() + 1).padStart(2, "0");
  const d = String(startedAt.getDate()).padStart(2, "0");
  return `R-${y}${m}${d}-${String(id).padStart(3, "0")}`;
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ items: [] satisfies LiveSessionItem[] });
    }

    // Task-scoped runs plus plan executors: an executor run has a planId but
    // no taskId (origin "chat"), so the origin filter alone would hide it.
    const runs = (await runsLib.listRuns()).filter(
      (r) => r.origin === "task" || r.goal === "<execute>",
    );
    const items: LiveSessionItem[] = [];
    for (const r of runs) {
      const task = r.taskId ? await repo.getTask(r.taskId) : null;
      const plan =
        r.goal === "<execute>" && r.planId ? await repo.getPlan(r.planId) : null;
      const b = bucketFor(r.status, r.prUrl, task?.state);
      if (!b) continue;
      const prMatch = r.prUrl?.match(/\/pull\/(\d+)/);
      let reason: string | null = null;
      if (b === "blocked") {
        if (r.status === "budget_exhausted") {
          const used = (r.totalCostUsd ?? 0).toFixed(2);
          const max = (r.budgetMaxUsd ?? 25).toFixed(0);
          reason = `Budget exhausted ($${used}/$${max})`;
        } else {
          reason = r.error || "Stopped per stop-rule";
        }
      }
      items.push({
        runDbId: r.id,
        shortId: shortRunId(r.id, r.startedAt),
        bucket: b,
        title:
          task?.title ||
          (plan ? `Execute: ${plan.title}` : null) ||
          r.title ||
          "(untitled run)",
        taskId: r.taskId,
        planId: plan?.id ?? null,
        branch: r.branch,
        prNum: prMatch ? parseInt(prMatch[1], 10) : null,
        persona: r.personaId,
        cost: r.totalCostUsd ?? 0,
        startedAt: r.startedAt.getTime(),
        reason,
      });
    }

    // One card per task — a review/blocked/running task usually has several
    // runs behind it (implement, review, fixes); show only its representative.
    const deduped = dedupeLiveByTask(items);
    deduped.sort((a, b) => {
      const d = LIVE_BUCKET_PRIORITY[a.bucket] - LIVE_BUCKET_PRIORITY[b.bucket];
      if (d !== 0) return d;
      return b.startedAt - a.startedAt;
    });

    return NextResponse.json({ items: deduped });
  } catch (e) {
    return errorResponse(e);
  }
}
