import { NextResponse } from "next/server";
import { getBackend } from "@/lib/agent-backend";

export const dynamic = "force-dynamic";

// Catalog of providers + models the active agent backend knows about. Used by
// the persona editor to render Provider/Model dropdowns.
export async function GET() {
  const backend = await getBackend();
  const providers = backend.listProviders();
  return NextResponse.json({ providers });
}
