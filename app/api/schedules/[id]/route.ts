import { NextResponse, type NextRequest } from "next/server";
import { resolveApiActor, unauthorizedResponse } from "@/lib/api-auth";
import { errorResponse } from "@/lib/api";
import { deleteSchedule, getScheduleSurface, updateSchedule } from "@/lib/schedules";
import { RepoError } from "@/lib/repo";
import { scheduleApiPatchSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

async function authenticated(req: NextRequest) {
  const result = await resolveApiActor(req);
  return result.ok && result.actor ? result.actor : null;
}

function idOf(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new RepoError("Invalid schedule id", 400);
  return id;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!await authenticated(req)) return unauthorizedResponse();
    const schedule = await getScheduleSurface(idOf((await params).id));
    return schedule ? NextResponse.json(schedule) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!await authenticated(req)) return unauthorizedResponse();
    const patch = scheduleApiPatchSchema.parse(await req.json());
    const schedule = await updateSchedule(idOf((await params).id), patch);
    return NextResponse.json(await getScheduleSurface(schedule.id));
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!await authenticated(req)) return unauthorizedResponse();
    const schedule = await deleteSchedule(idOf((await params).id));
    return NextResponse.json({ id: schedule.id, deleted: true });
  } catch (error) { return errorResponse(error); }
}
