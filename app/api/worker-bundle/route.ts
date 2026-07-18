// GET /api/worker-bundle — the standalone worker bundle this control plane
// was deployed with (dist/run-worker.standalone.js). A blank-provisioned Box
// curls this at launch, authenticated with its run-scoped channel credential;
// operators/API tokens can fetch it for debugging. The X-Bundle-Sha256 header
// is verified box-side after download.
// Spec: docs/superpowers/specs/2026-07-18-box-blank-provision-design.md §1.
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { runnerInstances } from "@/db/schema";
import { verifyToken } from "@/lib/api-tokens";
import { locateWorkerBundle } from "@/lib/worker-bundle";
import { verifyChannelCredential } from "@/lib/worker-channel/credential";
import { workerBuildSha } from "@/lib/runner/worker-sha";

async function authorized(req: Request): Promise<boolean> {
  const bearer = req.headers.get("authorization");
  const token = bearer?.startsWith("Bearer ") ? bearer.slice("Bearer ".length).trim() : null;

  // Run-scoped channel credential: the box presents the HMAC it was forked
  // with; we verify against the instance id recorded for that run.
  const runIdRaw = req.headers.get("x-run-id");
  if (token && runIdRaw) {
    const runId = Number.parseInt(runIdRaw, 10);
    if (Number.isInteger(runId) && runId > 0) {
      const [row] = await db
        .select({ channelInstanceId: runnerInstances.channelInstanceId })
        .from(runnerInstances)
        .where(and(eq(runnerInstances.runId, runId), eq(runnerInstances.provider, "box")));
      if (row?.channelInstanceId) {
        const verdict = verifyChannelCredential(token, runId, row.channelInstanceId);
        if (verdict.ok) return true;
      }
    }
    // fall through: a bad run-scoped attempt may still be a valid API token
  }

  if (token && (await verifyToken(token)) != null) return true;
  return (await auth()) != null;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const bundle = locateWorkerBundle(
    process.env.TASK_ORCH_BUNDLE_PATH ? { path: process.env.TASK_ORCH_BUNDLE_PATH } : {}
  );
  if (!bundle) {
    return NextResponse.json(
      { error: "Worker bundle not found on this deployment. Build it with `npm run build:worker:standalone`." },
      { status: 503 }
    );
  }

  const sha = await workerBuildSha().catch(() => "unknown");
  return new NextResponse(readFileSync(bundle.path), {
    status: 200,
    headers: {
      "content-type": "application/javascript",
      "content-length": String(bundle.size),
      "x-bundle-sha256": bundle.sha256,
      "x-worker-sha": sha,
      "cache-control": "no-store",
    },
  }) as NextResponse;
}
