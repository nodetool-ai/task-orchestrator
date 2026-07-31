// lib/discord-verify.ts
//
// The two things the Settings → Discord setup wizard needs from Discord itself:
// "is this token real?" and "what URL invites the bot?".
//
// Verification is a SERVER-side call on purpose. The token is a secret: the
// browser posts it once to /api/discord/verify (or names an already-stored bot)
// and never handles a bot token it did not already have.

const API_BASE = "https://discord.com/api/v10";

/** The permission bits the pipe's Discord adapter actually needs (README §Persona bots). */
export const INVITE_PERMISSIONS = {
  addReactions: 64n, // 👀 acks and ❌-as-stop
  sendMessages: 2048n,
  readMessageHistory: 65536n,
  createPublicThreads: 34359738368n,
  sendMessagesInThreads: 274877906944n,
} as const;

/** Sum of INVITE_PERMISSIONS, as the decimal string Discord's URL expects. */
export const INVITE_PERMISSIONS_VALUE = Object.values(INVITE_PERMISSIONS)
  .reduce((sum, bit) => sum + bit, 0n)
  .toString();

export interface DiscordVerifyResult {
  ok: boolean;
  /** Bot account username, when the token verified. */
  username?: string;
  /** Application id, when /applications/@me was readable. */
  applicationId?: string;
  /** Human-readable reason, when it did not verify. */
  error?: string;
}

/**
 * Check a bot token against Discord. NEVER throws: a bad token, a rate limit and
 * a DNS failure are all ordinary outcomes of "the user pasted something", so
 * they come back as `{ ok: false, error }` for the wizard to render inline.
 */
export async function verifyDiscordToken(token: string): Promise<DiscordVerifyResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, error: "Paste a bot token first." };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/users/@me`, {
      headers: { Authorization: `Bot ${trimmed}` },
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach Discord: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 401) {
    return { ok: false, error: "Discord rejected this token. Reset it in the Bot tab and retry." };
  }
  if (res.status === 429) {
    return { ok: false, error: "Discord rate-limited the check. Wait a moment and retry." };
  }
  if (!res.ok) {
    return { ok: false, error: `Discord replied HTTP ${res.status}.` };
  }

  const me = (await res.json().catch(() => ({}))) as { username?: string; id?: string };

  return {
    ok: true,
    username: me.username,
    // The application id is a nice-to-have (it only gates slash-command
    // registration and the invite URL), so a failure here is not a failure.
    applicationId: (await fetchApplicationId(trimmed)) ?? me.id,
  };
}

async function fetchApplicationId(token: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${API_BASE}/applications/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return undefined;
    const app = (await res.json()) as { id?: string };
    return typeof app.id === "string" ? app.id : undefined;
  } catch {
    return undefined;
  }
}

/** The OAuth2 URL that invites an application with the permissions above. */
export function inviteUrl(applicationId: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: "bot applications.commands",
    permissions: INVITE_PERMISSIONS_VALUE,
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}
