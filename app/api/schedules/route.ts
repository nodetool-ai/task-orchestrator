import { NextResponse, type NextRequest } from "next/server";
import { resolveApiActor, unauthorizedResponse } from "@/lib/api-auth";
import { errorResponse } from "@/lib/api";
import { createSchedule, getScheduleSurface, listScheduleSurfaces } from "@/lib/schedules";
import { scheduleApiInputSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

async function actorFor(req: NextRequest) {
  const result = await resolveApiActor(req);
  if (!result.ok || !result.actor) return null;
  return result.actor;
}

export async function GET(req: NextRequest) {
  try {
    if (!await actorFor(req)) return unauthorizedResponse();
    return NextResponse.json(await listScheduleSurfaces());
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await actorFor(req);
    if (!actor) return unauthorizedResponse();
    const input = scheduleApiInputSchema.parse(await req.json());
    const schedule = await createSchedule({ ...input, userId: actor.userId });
    return NextResponse.json(await getScheduleSurface(schedule.id), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
