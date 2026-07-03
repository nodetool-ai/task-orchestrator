import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

// Distinct assignees + persona ids — used by <AssigneePicker> to populate
// its autocomplete suggestions.
export async function GET() {
  const assignees = await repo.listAssignees();
  const personas = await repo.listPersonaIds();
  // Personas first (canonical names), then any other historic assignees.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...personas, ...assignees]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return NextResponse.json({ assignees: out });
}
