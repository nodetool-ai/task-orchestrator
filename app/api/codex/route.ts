import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { CodexLoginError } from "@/lib/codex-oauth-login";
import { codexAuthStatus, codexLogout, completeCodexLogin, startCodexLogin } from "@/lib/codex-oauth-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function authorized(): Promise<boolean> {
  const session = await auth();
  return Boolean(session?.user?.email);
}

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

function failure(err: unknown) {
  // A CodexLoginError is actionable by the user (expired or denied sign-in),
  // so it reports as 400 with its stable code; anything else is ours.
  if (err instanceof CodexLoginError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status: 500 }
  );
}

// Current Codex credential + whether a device login is outstanding.
export async function GET() {
  if (!(await authorized())) return unauthorized();
  return NextResponse.json(await codexAuthStatus());
}

// Start a device-code login. The UI opens verificationUrl, shows userCode,
// then polls PUT at the server-provided interval.
export async function POST() {
  if (!(await authorized())) return unauthorized();
  try {
    const deviceCode = await startCodexLogin();
    return NextResponse.json({ ...deviceCode, status: await codexAuthStatus() });
  } catch (err) {
    return failure(err);
  }
}

// Poll OpenAI once for authorization and exchange the code when ready.
export async function PUT(req: Request) {
  if (!(await authorized())) return unauthorized();
  try {
    const body = (await req.json().catch(() => ({}))) as { deviceAuthId?: unknown };
    if (typeof body.deviceAuthId !== "string") {
      return NextResponse.json({ error: "Expected a `deviceAuthId` string." }, { status: 400 });
    }
    return NextResponse.json(await completeCodexLogin(body.deviceAuthId));
  } catch (err) {
    return failure(err);
  }
}

// Sign out: revoke + clear the stored credential.
export async function DELETE() {
  if (!(await authorized())) return unauthorized();
  return NextResponse.json(await codexLogout());
}
