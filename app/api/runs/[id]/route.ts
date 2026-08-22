import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api-auth";
import * as runs from "@/lib/runs";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Bearer gate for the terminal cockpit (tui T-tui-11, lib/api-auth): a
    // presented token that does not verify is a 401; no Authorization header
    // means the middleware session gate already vouched for the request.
    const denied = await requireBearer(req);
    if (denied) return denied;
    const { id } = await params;
    const runId = parseInt(id, 10);
    if (!Number.isFinite(runId)) {
      return NextResponse.json({ error: "Bad id" }, { status: 400 });
    }
    const run = await runs.get(runId);
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const messages = await runs.listMessages(runId);
    return NextResponse.json({ ...run, messages, live: runs.isLive(runId) });
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH supports a small set of actions on a run:
//   { action: "close" }      → transition idle/active run to `closed`
//   { action: "cancel" }     → abort in-flight worker and mark cancelled
//   { action: "configure" }  → retune model / budget caps in place
//
// We model this as PATCH (rather than POST /close) to keep the surface
// route-flat: a unified /runs/[id] page already POSTs to ./messages for new
// turns; close/cancel are state transitions on the same resource.

// `{ action: "configure" }` fields. Every one is optional (patch semantics) but
// none may be junk: a run whose model silently stayed put because "sonet" was
// dropped is worse than a refusal. An explicit null clears the cap.
const configureSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  budgetMaxUsd: z.number().positive().finite().nullable().optional(),
  budgetMaxTurns: z.number().int().positive().nullable().optional(),
});

/** The first zod complaint as one line — the cockpit shows it verbatim. */
function issue(err: z.ZodError): string {
  const first = err.issues[0];
  return first ? `${first.path.join(".") || "body"} ${first.message.toLowerCase()}` : "invalid";
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Bearer gate — see the note above.
    const denied = await requireBearer(req);
    if (denied) return denied;
    const { id } = await params;
    const runId = parseInt(id, 10);
    if (!Number.isFinite(runId)) {
      return NextResponse.json({ error: "Bad id" }, { status: 400 });
    }
    let body: { action?: string } & Record<string, unknown>;
    try {
      body = (await req.json()) as { action?: string } & Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
    }
    if (body.action === "close") {
      const updated = await runs.close(runId);
      return NextResponse.json(updated);
    }
    if (body.action === "cancel") {
      const updated = await runs.cancel(runId);
      return NextResponse.json(updated);
    }
    if (body.action === "configure") {
      const patch = configureSchema.safeParse(body);
      // A rejected cap is a 400 rather than a silently ignored field: `/budget`
      // in the cockpit answers with one line, and "accepted, did nothing" is
      // the one answer an operator cannot act on.
      if (!patch.success) {
        return NextResponse.json({ error: `Bad configure: ${issue(patch.error)}` }, { status: 400 });
      }
      const { model, budgetMaxUsd, budgetMaxTurns } = patch.data;
      if (model === undefined && budgetMaxUsd === undefined && budgetMaxTurns === undefined) {
        return NextResponse.json({ error: "Bad configure: nothing to set" }, { status: 400 });
      }
      const updated = await runs.configure(runId, { model, budgetMaxUsd, budgetMaxTurns });
      return NextResponse.json(updated);
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
