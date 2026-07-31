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

// Every field optional — notably `token`, whose absence means "keep the stored
// one". The UI never holds the secret, so an edit of the allowlist must not
// require re-pasting it.
const PatchBody = z.object({
  token: z.string().min(1).optional(),
  applicationId: z.string().nullable().optional(),
  allowedChannels: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ personaId: string }> }
) {
  if (!(await authorized())) return unauthorized();
  const { personaId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  let updated: Awaited<ReturnType<typeof repo.updateDiscordBot>>;
  try {
    updated = await repo.updateDiscordBot(personaId, parsed.data);
  } catch (err) {
    const status = err instanceof repo.RepoError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const status = (await discordBotStatuses()).find((s) => s.personaId === personaId);
  return NextResponse.json({ bot: status ? serializeDiscordBot(status) : null });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ personaId: string }> }
) {
  if (!(await authorized())) return unauthorized();
  const { personaId } = await params;
  const removed = await repo.deleteDiscordBot(personaId);
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
