// Kick a manual environment build from the /environments page — or from CI,
// which warms the box template for a freshly-green main (bearer API token).
// Single-flight per (provider, worker SHA) via the environments live index; a
// manual build deliberately bypasses the failed-build cooldown (an explicit
// human/CI retry).
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { environments } from "@/db/schema";
import { config } from "@/lib/config";
import { verifyToken } from "@/lib/api-tokens";
import { dockerContextSha, workerBuildSha } from "@/lib/runner/worker-sha";
import { runBoxTemplateBuild } from "@/lib/runner/box-template-builder";
import { runDockerImageBuild } from "@/lib/runner/docker-image-build";
import { makeBoxClient } from "@/lib/runner/box-client";

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
  if (provider !== "box" && provider !== "docker") {
    return NextResponse.json({ error: "provider must be 'box' or 'docker' (fly builds are not in-app)" }, { status: 400 });
  }
  if (provider === "box" && !config.box.apiKey) {
    // A CI warm hitting a control plane without Box configured must fail
    // clearly instead of littering failed environment rows.
    return NextResponse.json({ error: "BOX_API_KEY is not configured on this deployment." }, { status: 503 });
  }

  // Box builds clone the pushed remote ref; the docker host build tars the
  // local checkout. Each artifact's identity is the SHA of what it actually
  // ships, so the row is keyed by the provider-appropriate resolver.
  let sha: string;
  try {
    sha = provider === "docker" ? await dockerContextSha() : await workerBuildSha();
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
