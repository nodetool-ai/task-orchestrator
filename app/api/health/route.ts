import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Liveness/readiness probe for Fly (and any load balancer / uptime check).
// Unauthenticated — see the /api/health bypass in middleware.ts. Always returns
// 200 when the Node server is up so a transient DB blip can't trigger a Fly
// health-check restart loop; the DB reachability is reported in the body for
// observability (`fly status` / dashboards) rather than gating liveness.
export async function GET() {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return NextResponse.json({ status: "ok", db: dbOk, uptime: process.uptime() });
}
