import { NextResponse } from "next/server";
import { shippedWorkerSha, workerBundleTarGz } from "@/lib/worker-bundle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/worker-bundle/<sha>.tar.gz — the worker bundle for the sprites
// runner. Unauthenticated (middleware bypass): sprites fetch it with a bare
// curl and the bundle is a build of the public worker repo, not a secret. Only
// the sha this image ships is served; see lib/worker-bundle.ts.
// Point TASK_ORCH_SPRITES_WORKER_BUNDLE_URL at
//   https://<control-plane>/api/worker-bundle/{sha}.tar.gz
const FILE = /^([0-9a-f]{40})\.tar\.gz$/;

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const m = FILE.exec(file);
  if (!m) return NextResponse.json({ error: "expected <sha>.tar.gz" }, { status: 400 });
  const shipped = await shippedWorkerSha();
  if (!shipped) {
    return NextResponse.json({ error: "no worker bundle sha baked into this image (deploy with --build-arg GIT_SHA)" }, { status: 503 });
  }
  if (m[1] !== shipped) {
    return NextResponse.json({ error: "bundle sha mismatch", requested: m[1], shipped }, { status: 404 });
  }
  let body: Buffer;
  try {
    body = await workerBundleTarGz();
  } catch {
    return NextResponse.json({ error: "worker bundle missing from image" }, { status: 503 });
  }
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(body.length),
      "content-disposition": `attachment; filename="worker-${shipped}.tar.gz"`,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
