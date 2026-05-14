import { NextResponse } from "next/server";
import { getProviders, getModels } from "@earendil-works/pi-ai";

export const dynamic = "force-dynamic";

// Catalog of providers + models pi-ai knows about. Used by the persona
// editor to render Provider/Model dropdowns. Filters out providers with
// no models so the UI doesn't show empty entries.
export async function GET() {
  const providers = getProviders()
    .map((id) => {
      const models = getModels(id).map((m) => ({ id: m.id, name: m.name }));
      return { id, models };
    })
    .filter((p) => p.models.length > 0);
  return NextResponse.json({ providers });
}
