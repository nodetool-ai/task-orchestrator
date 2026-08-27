import { NextResponse } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { isAuthDisabled } from "@/lib/auth-mode";
import { isCockpitRoute } from "@/lib/cockpit-routes";

// Auth.js gate. Every route requires a signed-in user except /login itself
// and Auth.js's own /api/auth/* handlers. Browser visitors are redirected
// to /login with a `next` param; /api/* requests get a 401 JSON response.
//
// Middleware runs on the Edge runtime, so it uses auth.config (no DB,
// no node:fs). Credential verification happens in auth.ts on the Node
// runtime when /api/auth/callback/credentials fires.
//
// The CLI talks to lib/repo directly, so it bypasses this gate.

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  // Local dev (NODE_ENV=development): no login gate. auth() returns a
  // synthetic dev-user session, so the layout and API routes still see a
  // logged-in user. See lib/auth-mode and auth.ts.
  if (isAuthDisabled()) return NextResponse.next();

  const path = req.nextUrl.pathname;

  if (path === "/login" || path === "/login-link" || path.startsWith("/api/auth/")) {
    return NextResponse.next();
  }
  // /api/health is an unauthenticated liveness/readiness probe; /api/metrics is
  // scraped by Fly's private Prometheus integration.
  if (path === "/api/health" || path === "/api/metrics") {
    return NextResponse.next();
  }
  // /api/worker-bundle is curl'd by sprites at bootstrap with no session; it
  // serves only the public worker build this image ships.
  if (path === "/api/worker-bundle") {
    return NextResponse.next();
  }
  // /api/mcp has its own Bearer-token auth (lib/api-tokens). Bypass the
  // session gate so MCP clients without a browser session can reach it.
  if (path === "/api/mcp") {
    return NextResponse.next();
  }
  // The terminal cockpit (`orch`, tui/) has no cookie jar, so it authenticates
  // with `Authorization: Bearer tot_…` — the same API tokens /api/mcp accepts
  // (lib/api-tokens). Middleware cannot verify one (Edge runtime: no DB, no
  // bcrypt), so it only forwards the request; each route below calls
  // lib/api-auth, which 401s a token that does not verify. The bypass is
  // deliberately narrowed to the cockpit's routes AND to requests that
  // actually carry an Authorization header, so no other API route can be
  // reached without a session by attaching a junk header.
  if (isCockpitRoute(path) && req.headers.has("authorization")) {
    return NextResponse.next();
  }
  // /api/github/webhook authenticates via the X-Hub-Signature-256 HMAC
  // (GITHUB_WEBHOOK_SECRET), not a browser session. Bypass the gate so GitHub
  // can deliver events.
  if (path === "/api/github/webhook") {
    return NextResponse.next();
  }
  if (req.auth) return NextResponse.next();

  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", path);
  return NextResponse.redirect(url);
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
