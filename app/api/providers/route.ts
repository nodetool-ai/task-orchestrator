import { NextResponse } from "next/server";
import { BACKEND_IDS, getBackend, resolveBackendId } from "@/lib/agent-backend";

export const dynamic = "force-dynamic";

// Catalog of providers + models per agent backend. `providers` stays the
// deployment-default backend's catalog (persona editor and other legacy
// consumers); `backends` carries every backend's catalog so run composers can
// offer a per-run backend choice, and `defaultBackend` names the deployment
// default a run with no explicit pick executes on. Instantiating a backend
// for listProviders is cheap — the heavy SDK import happens inside runTurn.
export async function GET() {
  const defaultBackend = resolveBackendId();
  const backends = await Promise.all(
    BACKEND_IDS.map(async (id) => ({
      id,
      providers: (await getBackend(id)).listProviders(),
    }))
  );
  const providers = backends.find((b) => b.id === defaultBackend)?.providers ?? [];
  return NextResponse.json({ providers, backends, defaultBackend });
}
