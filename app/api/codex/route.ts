import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { codexAuthStatus, codexWebLogout, startCodexWebLogin } from "@/lib/codex-oauth-web";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function authorized(): Promise<boolean> {
  const session = await auth();
  return Boolean(session?.user?.email);
}

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// Current Codex credential + any in-flight login.
export async function GET() {
  if (!(await authorized())) return unauthorized();
  return NextResponse.json(codexAuthStatus());
}

// Start (or rejoin) the interactive "Sign in with ChatGPT" flow. Returns the
// authorization URL for the browser to open; the exchange finishes in the
// background and the client polls GET until `signedIn`.
export async function POST() {
  if (!(await authorized())) return unauthorized();
  try {
    const { authorizationUrl } = await startCodexWebLogin();
    return NextResponse.json({ authorizationUrl, status: codexAuthStatus() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

// Sign out: revoke + clear the local credential.
export async function DELETE() {
  if (!(await authorized())) return unauthorized();
  await codexWebLogout();
  return NextResponse.json(codexAuthStatus());
}
