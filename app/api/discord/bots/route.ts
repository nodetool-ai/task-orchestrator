import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { serializeDiscordBot } from "@/lib/discord-bots";
import { discordBotStatuses } from "@/lib/pipe/config";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function authorized(): Promise<boolean> {
  const session = await auth();
  return Boolean(session?.user?.email);
}

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

const PostBody = z.object({
  personaId: z.string().min(1),
  token: z.string().min(1),
  applicationId: z.string().nullable().optional(),
  allowedChannels: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export async function GET() {
  if (!(await authorized())) return unauthorized();
  const bots = (await discordBotStatuses()).map(serializeDiscordBot);
  return NextResponse.json({ bots });
}

// Create or replace the bot for a persona (the wizard's final step, and the
// "replace token" path — persona_id is the key, so this is idempotent).
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
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  try {
    await repo.upsertDiscordBot(parsed.data);
  } catch (err) {
    const status = err instanceof repo.RepoError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }

  const statuses = await discordBotStatuses();
  const bot = statuses.find((s) => s.personaId === parsed.data.personaId);
  return NextResponse.json({ bot: bot ? serializeDiscordBot(bot) : null });
}
