import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import * as runsLib from "@/lib/runs";
import { auth } from "@/auth";
import { errorResponse } from "@/lib/api";
import type { LiveSessionItem } from "@/components/pi/live-sidebar";

export const dynamic = "force-dynamic";

const ACTIVE = new Set(["preparing", "running", "pushing"]);
const REVIEW = new Set(["opening_pr"]);
const BLOCKED = new Set(["failed", "budget_exhausted"]);

type Bucket = LiveSessionItem["bucket"];

function shortRunId(id: number, startedAt: Date): string {
  const y = startedAt.getFullYear();
  const m = String(startedAt.getMonth() + 1).padStart(2, "0");
  const d = String(startedAt.getDate()).padStart(2, "0");
  return `R-${y}${m}${d}-${String(id).padStart(3, "0")}`;
}

function bucketFor(status: string, prUrl: string | null): Bucket | null {
  if (ACTIVE.has(status)) return "running";
  if (REVIEW.has(status) || prUrl) return "review";
  if (BLOCKED.has(status)) return "blocked";
  return null;
}

// Sort order: review first (loudest attention), then blocked, then running (newest first within).
const BUCKET_ORDER: Record<Bucket, number> = { review: 0, blocked: 1, running: 2 };

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ items: [] satisfies LiveSessionItem[] });
    }

    const runs = runsLib.listRuns().filter((r) => r.origin === "task");
    const items: LiveSessionItem[] = [];
    for (const r of runs) {
      const b = bucketFor(r.status, r.prUrl);
      if (!b) continue;
      const task = r.taskId ? repo.getTask(r.taskId) : null;
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
        title: task?.title || r.title || "(untitled run)",
        taskId: r.taskId,
        branch: r.branch,
        prNum: prMatch ? parseInt(prMatch[1], 10) : null,
        persona: r.personaId,
        cost: r.totalCostUsd ?? 0,
        startedAt: r.startedAt.getTime(),
        reason,
      });
    }

    items.sort((a, b) => {
      const d = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
      if (d !== 0) return d;
      return b.startedAt - a.startedAt;
    });

    return NextResponse.json({ items });
  } catch (e) {
    return errorResponse(e);
  }
}
