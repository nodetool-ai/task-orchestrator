import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import * as repo from "@/lib/repo";
import { findUser } from "@/lib/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Every handler here operates on the SESSION USER'S OWN row and nothing else:
// linking is self-service, and one person must not be able to add, change or
// remove another person's Discord access.
async function currentUserId(): Promise<number | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;
  const u = await findUser(email);
  return u?.id ?? null;
}

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// Discord ids are snowflakes: 17-20 digits today, digits-only forever. Catching
// a pasted username here is worth more than a permissive field, because the
// mistake otherwise surfaces as "the bot ignores me" with no explanation.
const PutBody = z.object({
  externalUserId: z
    .string()
    .trim()
    .regex(/^\d{15,25}$/, "Expected a numeric Discord user id (Developer Mode → Copy User ID)."),
  label: z.string().trim().max(120).nullable().optional(),
});

async function serializeFor(userId: number) {
  const identity = await repo.getChannelIdentityForUser(userId, "discord");
  const linkedCount = (await repo.listChannelIdentityExternalIds("discord")).length;
  return {
    identity: identity
      ? {
          externalUserId: identity.externalUserId,
          label: identity.label,
          createdAt: identity.createdAt.toISOString(),
        }
      : null,
    // How many people have linked in total — the wizard needs to know whether
    // ANY human can reach the bots, not just whether the current one can.
    linkedCount,
    // Legacy ids from DISCORD_ALLOWED_USERS, which still count as reachable.
    envAllowedUsers: (process.env.DISCORD_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export async function GET() {
  const userId = await currentUserId();
  if (userId === null) return unauthorized();
  return NextResponse.json(await serializeFor(userId));
}

// Set (or move) the caller's own Discord id. The unique key is
// (channel, external_user_id), so claiming an id another account holds
// re-points it — the same fixable-by-the-user behaviour `/link` has.
export async function PUT(req: Request) {
  const userId = await currentUserId();
  if (userId === null) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const parsed = PutBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  // Replace rather than accumulate: one Discord account per app user here.
  const existing = await repo.getChannelIdentityForUser(userId, "discord");
  if (existing && existing.externalUserId !== parsed.data.externalUserId) {
    await repo.deleteChannelIdentity("discord", existing.externalUserId);
  }
  await repo.upsertChannelIdentity({
    channel: "discord",
    externalUserId: parsed.data.externalUserId,
    userId,
    label: parsed.data.label ?? null,
  });
  return NextResponse.json(await serializeFor(userId));
}

export async function DELETE() {
  const userId = await currentUserId();
  if (userId === null) return unauthorized();
  const existing = await repo.getChannelIdentityForUser(userId, "discord");
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await repo.deleteChannelIdentity("discord", existing.externalUserId);
  return NextResponse.json(await serializeFor(userId));
}
