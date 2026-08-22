import { NextResponse, type NextRequest } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import * as repo from "@/lib/repo";
import { createTaskSchema, taskStateEnum } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // Bearer gate for the terminal cockpit (tui T-tui-11, lib/api-auth): a
    // presented token that does not verify is a 401; no Authorization header
    // means the middleware session gate already vouched for the request.
    const denied = await requireBearer(req);
    if (denied) return denied;
    const sp = req.nextUrl.searchParams;
    const filters: Parameters<typeof repo.listTasks>[0] = {};
    const rawState = sp.get("state");
    if (rawState) {
      const parsed = taskStateEnum.safeParse(rawState);
      if (!parsed.success) {
        return NextResponse.json({ error: `Invalid state: ${rawState}` }, { status: 400 });
      }
      filters.state = parsed.data;
    }
    const plan = sp.get("plan");
    if (plan) filters.planId = plan;
    const assignee = sp.get("assignee");
    if (assignee) filters.assignee = assignee;
    return NextResponse.json(await repo.listTasks(filters));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    // Bearer gate — see the note above.
    const denied = await requireBearer(req);
    if (denied) return denied;
    const input = createTaskSchema.parse(await req.json());
    const task = await repo.createTask({
      id: input.id,
      planId: input.plan,
      title: input.title,
      assignee: input.assignee ?? null,
      body: input.body,
      estimate: input.estimate ?? null,
      tags: input.tags,
      dependencies: input.dependencies,
      criteria: input.criteria,
      date: input.date,
      repoId: input.repoId ?? undefined,
    });
    return NextResponse.json(task, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
