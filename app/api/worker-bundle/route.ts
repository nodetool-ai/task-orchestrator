import { NextResponse } from "next/server";
import { workerBundleId, workerBundleTarGz } from "@/lib/worker-bundle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/worker-bundle — the worker bundle this image ships, as the tarball
// the sprites bootstrap expects. Unauthenticated (middleware bypass): sprites
// fetch it with a bare curl and the bundle is a build of the public worker
// repo, not a secret. The ETag is the bundle id (sha1 of the shipped file).
export async function GET() {
  let id: string;
  let body: Buffer;
  try {
    id = await workerBundleId();
    body = await workerBundleTarGz();
  } catch {
    return NextResponse.json({ error: "worker bundle missing from image (npm run build:worker:standalone)" }, { status: 503 });
  }
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(body.length),
      "content-disposition": `attachment; filename="worker-${id}.tar.gz"`,
      etag: `"${id}"`,
      "cache-control": "no-cache",
    },
  });
}
