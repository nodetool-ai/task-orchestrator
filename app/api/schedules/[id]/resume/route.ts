import { NextResponse, type NextRequest } from "next/server";
import { resolveApiActor, unauthorizedResponse } from "@/lib/api-auth";
import { errorResponse } from "@/lib/api";
import { getScheduleSurface, resumeSchedule } from "@/lib/schedules";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const auth = await resolveApiActor(req); if (!auth.ok || !auth.actor) return unauthorizedResponse(); const id = Number((await params).id); if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: "Invalid schedule id" }, { status: 400 }); await resumeSchedule(id); return NextResponse.json(await getScheduleSurface(id)); } catch (error) { return errorResponse(error); }
}
