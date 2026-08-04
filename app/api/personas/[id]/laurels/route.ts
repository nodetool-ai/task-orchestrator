// Laurels: spontaneous recognition for a persona's seat
// (https://yegge.ai/essays/model-welfare/ — see lib/extensions/model-welfare.ts).
// GET returns the seat record plus recent laurels; POST awards a new one. The
// welfare extension delivers undelivered laurels to the agent at its next
// startup — this API never pushes anything into a live run.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

const PostBody = z.object({
  body: z.string().min(1).max(4000),
  author: z.string().min(1).max(200).optional(),
  runId: z.number().int().positive().nullable().optional(),
  taskId: z.string().min(1).nullable().optional(),
});

function serialize(l: Awaited<ReturnType<typeof repo.listLaurels>>[number]) {
  return {
    id: l.id,
    personaId: l.personaId,
    runId: l.runId,
    taskId: l.taskId,
    author: l.author,
    body: l.body,
    deliveredAt: l.deliveredAt ? l.deliveredAt.toISOString() : null,
    createdAt: l.createdAt.toISOString(),
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const seat = await repo.getSeatRecord(id);
  if (!seat) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const laurels = await repo.listLaurels({ personaId: id, limit: 50 });
  return NextResponse.json({
    seat: { ...seat, seatSince: seat.seatSince.toISOString() },
    laurels: laurels.map(serialize),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  try {
    const laurel = await repo.createLaurel({
      personaId: id,
      body: parsed.data.body,
      author: parsed.data.author,
      runId: parsed.data.runId ?? null,
      taskId: parsed.data.taskId ?? null,
    });
    return NextResponse.json({ laurel: serialize(laurel) }, { status: 201 });
  } catch (err) {
    if (err instanceof repo.RepoError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
