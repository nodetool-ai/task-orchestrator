// Auto-naming for chats.
//
// Every chat is created with the placeholder title "New chat" (see
// lib/chat.ts:createChat) and is renamed from its first user message so the
// /runs list and the Discord bridge show the conversation's topic instead of a
// placeholder or a raw channel id.
//
// Two layers, best-to-worst:
//   1. generateChatTitle() — a short, human-friendly title from a fast model
//      (like every modern chat app). Best-effort: it needs a credential in the
//      env and one cheap round-trip, and returns null on anything unexpected.
//   2. deriveTitle() — a deterministic clean-up of the raw message. Always
//      available, no network, no credentials. This is the fallback and the
//      floor: a chat is never left showing "New chat" once it has a message.
//
// runChat sets the derived title synchronously (so the UI updates immediately)
// and, when the model is reachable, upgrades it to the generated one.

const MAX_TITLE_LEN = 60;

// The fast, cheap model used for titling. Deliberately not the chat's own model:
// a one-line title never needs the frontier tier, and a small model keeps the
// call sub-second. Provider-stripped before use (the raw SDK wants a bare id).
const TITLE_MODEL = (process.env.TASK_ORCH_TITLE_MODEL ?? "claude-haiku-4-5-20251001").replace(
  /^[^/]+\//,
  ""
);

const SYSTEM_PROMPT =
  "You write terse titles for chat conversations. Given the user's first " +
  "message, reply with a title of at most 6 words that captures its topic. " +
  "Reply with ONLY the title — no quotes, no punctuation at the end, no " +
  "preamble, no markdown.";

/**
 * Collapse a raw message into a clean, bounded, single-line title. Strips
 * markdown noise (code fences, heading/list/quote markers, inline emphasis),
 * collapses whitespace, and truncates on a word boundary with an ellipsis.
 * Always returns a string; empty only if the input has no visible characters.
 */
export function deriveTitle(raw: string): string {
  let text = raw
    // Drop fenced code blocks wholesale — they make useless titles.
    .replace(/```[\s\S]*?```/g, " ")
    // Inline code / emphasis markers → keep the contents, drop the marks.
    .replace(/[`*_~]+/g, "")
    // Leading markdown structure on any line: headings, list bullets, quotes.
    .replace(/^\s*(?:[#>\-*+]+|\d+\.)\s+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= MAX_TITLE_LEN) return text;

  // Truncate on a word boundary within the budget, then add an ellipsis.
  const clipped = text.slice(0, MAX_TITLE_LEN - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  const head = lastSpace > MAX_TITLE_LEN / 2 ? clipped.slice(0, lastSpace) : clipped;
  return head.replace(/[\s.,;:!?-]+$/, "") + "…";
}

/** Tidy a model-produced title: strip wrapping quotes, markdown, trailing
 *  punctuation, and enforce the length budget. Returns null if nothing usable
 *  survives (so callers keep the deterministic fallback). */
function cleanGeneratedTitle(raw: string): string | null {
  let title = raw.trim();
  // Models sometimes wrap the title in quotes despite the instruction.
  title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
  // Collapse to one line and drop markdown emphasis.
  title = title.replace(/[`*_~]+/g, "").replace(/\s+/g, " ").trim();
  // Drop a single trailing sentence terminator ("Fixing the login bug." → …bug).
  title = title.replace(/[.!?]+$/, "").trim();
  if (!title) return null;
  return deriveTitle(title);
}

/** Build an Anthropic client from whatever credential the env carries, or null
 *  if none is present. Mirrors how the Claude backend resolves auth: a plain
 *  API key when set, otherwise the OAuth/subscription token (which needs the
 *  oauth beta header on the raw Messages API). */
async function resolveClient(): Promise<{
  create: (body: any, options: any) => Promise<any>;
} | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_OAUTH_TOKEN;
  if (!apiKey && !oauthToken) return null;

  // Dynamic import so the SDK never loads for callers that don't title (and so
  // this module stays cheap to import in tests).
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = apiKey
    ? new Anthropic({ apiKey, maxRetries: 0 })
    : new Anthropic({
        authToken: oauthToken,
        maxRetries: 0,
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      });
  return {
    create: (body: any, options: any) => client.messages.create(body, options),
  };
}

/**
 * Ask a fast model for a concise title for the conversation, given its first
 * user message. Best-effort: returns null when no credential is available, when
 * the call fails or times out, or when the reply isn't usable — the caller then
 * keeps deriveTitle()'s deterministic result. Never throws.
 */
export async function generateChatTitle(
  firstMessage: string,
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  const text = firstMessage.trim();
  if (!text) return null;

  let client: { create: (body: any, options: any) => Promise<any> } | null;
  try {
    client = await resolveClient();
  } catch {
    return null;
  }
  if (!client) return null;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await client.create(
      {
        model: TITLE_MODEL,
        max_tokens: 32,
        system: SYSTEM_PROMPT,
        // Cap the input we send: a title only needs the opening of a long
        // message, and this keeps the request small and fast.
        messages: [{ role: "user", content: text.slice(0, 2000) }],
      },
      { signal: abort.signal }
    );
    const block = Array.isArray(res?.content)
      ? res.content.find((b: any) => b?.type === "text")
      : null;
    const out = typeof block?.text === "string" ? block.text : "";
    return cleanGeneratedTitle(out);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
