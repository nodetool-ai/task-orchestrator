import { NextResponse } from "next/server";
import { listProfiles } from "@/lib/profiles";

export const dynamic = "force-dynamic";

// Static catalog of tool-profile keys the runner knows how to mount.
// Used by the persona editor to render the multi-select tool picker so
// the UI stays in sync with code without manual list duplication.
export async function GET() {
  return NextResponse.json({ profiles: listProfiles() });
}
