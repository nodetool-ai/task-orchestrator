// Kick a manual environment build from the /environments page. Single-flight
// per (provider, worker SHA) via the environments live index; a manual build
// deliberately bypasses the failed-build cooldown (an explicit human retry).
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { environments } from "@/db/schema";
import { workerBuildSha } from "@/lib/runner/worker-sha";
import { runBoxTemplateBuild } from "@/lib/runner/box-template-builder";
import { runDockerImageBuild } from "@/lib/runner/docker-image-build";
import { makeBoxClient } from "@/lib/runner/box-client";

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider;
  if (provider !== "box" && provider !== "docker") {
    return NextResponse.json({ error: "provider must be 'box' or 'docker' (fly builds are not in-app)" }, { status: 400 });
  }

  let sha: string;
  try {
    sha = await workerBuildSha();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }

  const [live] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.provider, provider), eq(environments.workerSha, sha), inArray(environments.state, ["building", "ready"])));
  if (live) {
    return NextResponse.json(
      {
        error: live.state === "building"
          ? "A build is already in progress for the current worker SHA."
          : "An environment is already ready for the current worker SHA; a rebuild only makes sense after the SHA drifts.",
        state: live.state,
      },
      { status: 409 }
    );
  }

  try {
    const [row] = await db.insert(environments).values({ provider, workerSha: sha }).returning();
    if (provider === "box") {
      void runBoxTemplateBuild(makeBoxClient(), { registryId: row.id, runId: null, workerSha: sha }).catch((err) => {
        console.error(`manual box environment build ${row.id} crashed:`, err);
      });
    } else {
      void runDockerImageBuild({ environmentId: row.id }).catch((err) => {
        console.error(`manual docker environment build ${row.id} crashed:`, err);
      });
    }
    return NextResponse.json({ id: row.id, state: "building" }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "A build is already in progress." }, { status: 409 }); // insert race
  }
}
