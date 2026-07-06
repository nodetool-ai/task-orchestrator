// app/api/worker/[...path]/route.ts
//
// The worker HTTP + SSE protocol surface. All routing, auth (run-scoped bearer
// tokens — NOT the browser session), validation, and logging live in
// lib/worker/api-handlers so the whole surface is unit-testable; this file is
// only the Next.js binding. Endpoint table: docs/worker-http-api.md.

import { type NextRequest } from "next/server";
import { handleWorkerApi } from "@/lib/worker/api-handlers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return handleWorkerApi(req, path ?? []);
}

export { handle as GET, handle as POST, handle as PATCH };
