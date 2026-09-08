import { NextResponse } from "next/server";
import { getBackend, resolveBackendId } from "@/lib/agent-backend";

export const dynamic = "force-dynamic";

// The one deployment-wide backend determines the only model catalog exposed
// to the UI. The heavy SDK import still happens lazily inside runTurn.
export async function GET() {
  const defaultBackend = resolveBackendId();
  const providers = (await getBackend(defaultBackend)).listProviders();
  return NextResponse.json({ providers, defaultBackend });
}
