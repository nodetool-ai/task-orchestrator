// Kick a manual environment build from the /environments page — or from CI
// (bearer API token). Single-flight per (provider, worker SHA) via the
// environments live index.
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { environments } from "@/db/schema";
import { verifyToken } from "@/lib/api-tokens";
import { dockerContextSha } from "@/lib/runner/worker-sha";
import { runDockerImageBuild } from "@/lib/runner/docker-image-build";

async function authorized(req: Request): Promise<boolean> {
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    return (await verifyToken(bearer.slice("Bearer ".length).trim())) != null;
  }
  return (await auth()) != null;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider;
  if (provider !== "docker") {
    return NextResponse.json({ error: "provider must be 'docker'" }, { status: 400 });
  }

  // The docker host build tars the local checkout, so the artifact's identity
  // is the SHA of what it actually ships.
  let sha: string;
  try {
    sha = await dockerContextSha();
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
    void runDockerImageBuild({ environmentId: row.id }).catch((err) => {
      console.error(`manual docker environment build ${row.id} crashed:`, err);
    });
    return NextResponse.json({ id: row.id, state: "building" }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "A build is already in progress." }, { status: 409 }); // insert race
  }
}
