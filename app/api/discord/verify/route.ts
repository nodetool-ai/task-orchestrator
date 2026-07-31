import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { inviteUrl, verifyDiscordToken } from "@/lib/discord-verify";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function authorized(): Promise<boolean> {
  const session = await auth();
  return Boolean(session?.user?.email);
}

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

const PostBody = z.object({ token: z.string().min(1) });

function respond(result: Awaited<ReturnType<typeof verifyDiscordToken>>) {
  // A bad token is the user's paste, not a server fault: always 200, with the
  // verdict in the body, so the wizard can render it inline.
  return NextResponse.json({
    ok: result.ok,
    username: result.username ?? null,
    applicationId: result.applicationId ?? null,
    inviteUrl: result.applicationId ? inviteUrl(result.applicationId) : null,
    error: result.error ?? null,
  });
}

// Verify a token the user just pasted. It is checked and discarded — nothing is
// stored until the wizard finishes with a POST to /api/discord/bots.
export async function POST(req: Request) {
  if (!(await authorized())) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected a `token` string." }, { status: 400 });
  }

  return respond(await verifyDiscordToken(parsed.data.token));
}

// Re-check an ALREADY-STORED bot: ?personaId=concierge. The browser names the
// bot instead of holding its token, so "is this still valid?" never requires
// the secret to leave the server.
export async function GET(req: Request) {
  if (!(await authorized())) return unauthorized();

  const personaId = new URL(req.url).searchParams.get("personaId")?.trim();
  if (!personaId) {
    return NextResponse.json({ error: "personaId is required" }, { status: 400 });
  }
  const bot = await repo.getDiscordBot(personaId);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return respond(await verifyDiscordToken(bot.token));
}
