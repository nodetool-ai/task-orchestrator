// lib/pipe/commands.ts
//
// Slash-command interception — claude-pipe style. The agent loop calls
// handleCommand() before any LLM turn; a handled command replies instantly
// (no tokens spent). Unknown slashes fall through and are treated as a prompt.
//
// This module is the single command registry: the same handler serves plain
// text commands typed into a channel AND registered Discord application
// commands (SLASH_COMMANDS below is what the adapter PUTs at boot, and an
// incoming interaction is flattened back into "/name args" before it gets
// here). Deliberately transport-free — no discord.js import.

import { consumeToken, verifyToken } from "@/lib/api-tokens";
import * as chat from "@/lib/chat";
import * as repo from "@/lib/repo";
import { isLeaseLive } from "@/lib/run-liveness";
import * as runs from "@/lib/runs";
import { getUserById } from "@/lib/users";

import { startFreshConversation } from "./carryover";
import { buildStatusDigest } from "./digest";
import { planLink, runLink, taskLink } from "./links";
import { currentRunId, getOrCreateRun, resolveUserId } from "./session-store";
import type { InboundMessage, PipeConfig, SlashCommandSpec } from "./types";

export interface CommandResult {
  /** false => not a known command; the loop treats the text as a prompt. */
  handled: boolean;
  /** Immediate reply to send (no agent turn). */
  reply?: string;
}

/**
 * The command surface registered as Discord application commands on every bot
 * (PRD §7). `/model` is deliberately absent: it survives as a hidden power-user
 * text command, undocumented in /help and not registered.
 */
export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: "status", description: "What am I working on right now?" },
  { name: "new", description: "Start a fresh conversation in this thread/DM" },
  { name: "stop", description: "Interrupt the turn I'm running" },
  {
    name: "link",
    description: "Link this Discord account to your orchestrator account (DM only)",
    options: [
      {
        type: 3,
        name: "token",
        description: "An API token from the web UI. Never share it.",
        required: true,
      },
    ],
  },
  { name: "whoami", description: "Who I am, who you are, and what this thread is" },
  { name: "help", description: "Short cheat sheet" },
];

// A turn may run either in this (bridge) process — tracked by runs.isLive via the
// in-process runners map — or in the web server process, which shares the same
// Postgres. The web turn is invisible to isLive/interrupt, so /status and /stop
// also consult the DB liveness lease: an active status with a fresh heartbeat.

/** True when the run holds a live DB lease (active status + fresh heartbeat). */
function leaseLive(run: runs.RunRow | null): boolean {
  return run != null && isLeaseLive(run);
}

const HELP = [
  "**Commands**",
  "`/status` — what I'm working on right now",
  "`/stop` — interrupt my current turn (aliases: `/cancel`, `/abort`, or just say \"stop\")",
  "`/new` or `/reset` — start a fresh conversation",
  "`/link <token>` — link your account, in a DM (grab a token in the web UI)",
  "`/whoami` or `/session` — who I am, who you are, what this thread is",
  "`/help` — this message",
  "Anything else is just talk — send it and I'll get on it.",
].join("\n");

/**
 * Plain-language interrupts. Recognized BEFORE the per-conversation queue by
 * the agent loop (PRD §6), so "stop" aborts the turn it is aimed at instead of
 * waiting behind it. Kept tight on purpose: a bare "stop"/"cancel"/"abort",
 * optionally punctuated. Anything longer ("stop the deploy") is a real prompt.
 */
export function isPlainStop(text: string): boolean {
  return /^(stop|cancel|abort)\s*[.!]*$/i.test(text.trim());
}

/** True when the text is handled out of band (pre-queue) by handleCommand. */
export function isCommandText(text: string): boolean {
  return text.trim().startsWith("/") || isPlainStop(text);
}

/**
 * Commands that are about the CONVERSATION rather than the channel they were
 * typed in. Invoked in a guild parent channel these mean "the thread this
 * persona has open below" (M4 review F8) — `/stop` typed in #dev is aimed at
 * the turn running in the thread, not at the channel itself.
 */
// `/new` is deliberately NOT here: "start a fresh conversation" typed in a
// channel most plausibly means "here", and silently resetting the thread below
// would throw away a conversation the user wasn't looking at.
const CONVERSATION_SCOPED = new Set(["stop", "cancel", "abort", "status", "whoami", "session"]);

export function isConversationScopedCommand(name: string): boolean {
  return CONVERSATION_SCOPED.has(name.toLowerCase());
}

/** The command name in a line of text ("/status now" → "status"), or null. */
export function commandNameOf(text: string): string | null {
  const raw = text.trim();
  if (isPlainStop(raw)) return "stop";
  if (!raw.startsWith("/")) return null;
  const name = raw.slice(1).split(/\s+/)[0];
  return name ? name.toLowerCase() : null;
}

/**
 * An API token (`tot_` + 43 base64url chars, see lib/api-tokens.ts) anywhere in
 * the text. Used pre-queue to refuse forwarding the message at all: the usual
 * way a token ends up in an ordinary message is a typo'd command (`/lnik tot_…`,
 * `link tot_…`), and forwarding it would persist the secret in agent_messages
 * and hand it to a model provider — neither of which can be walked back.
 */
const API_TOKEN_RE = /tot_[A-Za-z0-9_-]{43}/;

export function containsApiToken(text: string): boolean {
  return API_TOKEN_RE.test(text);
}

/** The refusal for a token-shaped message. Deliberately does not echo the text. */
export const TOKEN_IN_MESSAGE_NOTICE =
  "🛑 That looks like an API token — I won't process it, and I haven't stored it. " +
  "Use `/link <token>` in a DM with me, and consider revoking that token in the web UI.";

export async function handleCommand(
  msg: InboundMessage,
  config: PipeConfig
): Promise<CommandResult> {
  const raw = msg.text.trim();
  // A plain-language interrupt is routed as if it were /stop, so there is one
  // implementation of "abort this turn".
  const line = isPlainStop(raw) ? "/stop" : raw;
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const personaId = msg.personaId;

  switch (cmd.toLowerCase()) {
    case "stop":
    case "cancel":
    case "abort": {
      // Interrupt the in-flight turn for this conversation. The /stop message is
      // dispatched concurrently with the running turn (the agent loop is
      // fire-and-forget per message), so this aborts the live runner directly —
      // it doesn't queue behind the turn it's trying to kill.
      const id = await currentRunId(msg.channel, msg.externalId, personaId);
      if (!id) {
        return { handled: true, reply: "Nothing to stop — no active conversation yet." };
      }
      const stopped = await runs.interrupt(id);
      if (stopped) {
        return {
          handled: true,
          reply: `⏹️ Stopped run #${id}. Send another message to continue, or \`/new\` to start fresh.`,
        };
      }
      // No local runner to abort. If the DB lease is live, the turn is owned by
      // another process (e.g. the web composer) — say so rather than claiming
      // nothing is running, which would be plainly wrong to the user.
      if (leaseLive(await runs.getRun(id))) {
        return {
          handled: true,
          reply: `Run #${id} is working in another process (e.g. the web app). \`/stop\` can only interrupt turns started here — stop it from where it was started.`,
        };
      }
      return {
        handled: true,
        reply: `Nothing to stop — run #${id} isn't working on anything right now.`,
      };
    }

    case "status": {
      // PRD J3: the digest is the answer — live state, no model call, no agent
      // turn, so it lands in well under the 5-second target. The old
      // "is this thread's run busy?" line survives as the digest's trailing
      // line, because it is what tells the user whether `/stop` has anything to
      // interrupt.
      const userId = await resolveUserId(msg.channel, msg.authorId);

      const id = await currentRunId(msg.channel, msg.externalId, personaId);
      if (!id) {
        return {
          handled: true,
          reply: await buildStatusDigest(personaId, userId, "This thread has no conversation yet."),
        };
      }
      const run = await runs.getRun(id);
      // A turn started here → we can stop it. A turn started in the web process
      // shows a live DB lease but no local runner → report it, but be honest
      // that /stop won't reach it. Otherwise the run is idle.
      const here = runs.isLive(id)
        ? `⏳ This thread: working on run #${id} — \`/stop\` to interrupt.`
        : leaseLive(run)
          ? `⏳ This thread: run #${id} is working in another process (e.g. the web app); \`/stop\` can't reach it.`
          : `⚪ This thread: run #${id} idle.`;
      // Folded into the digest's trailing line rather than added as its own, so
      // the whole answer keeps the PRD's ~5-lines-then-summarize shape.
      return { handled: true, reply: await buildStatusDigest(personaId, userId, here) };
    }

    case "new":
    case "reset": {
      // `/new` is not amnesia: the fresh run starts with a short carried-over
      // summary of the old thread (PRD §10), assembled without a model call.
      // Durable facts already live in memory and travel on their own.
      const { runId, summary } = await startFreshConversation({
        channel: msg.channel,
        externalId: msg.externalId,
        personaId,
        authorId: msg.authorId,
        model: config.defaultModel,
      });
      return {
        handled: true,
        reply:
          `Started a fresh conversation (run #${runId}).` +
          (summary ? " I kept a short summary of what we were doing." : ""),
      };
    }

    case "model": {
      if (!arg) {
        const id = await currentRunId(msg.channel, msg.externalId, personaId);
        const m = (id && (await chat.getChat(id))?.model) || config.defaultModel;
        return {
          handled: true,
          reply: `Current model: \`${m}\`. Usage: \`/model provider/id\``,
        };
      }
      const runId = await getOrCreateRun(msg.channel, msg.externalId, personaId, {
        model: config.defaultModel,
        authorId: msg.authorId,
      });
      await chat.updateChatSettings(runId, { model: arg }); // expects a provider-qualified id
      return { handled: true, reply: `Model set to \`${arg}\` for run #${runId}.` };
    }

    case "link": {
      // DM ONLY (design §6). A bearer token pasted in a guild channel is
      // readable by everyone in it, so refuse — and do NOT delete the message:
      // deleting needs Manage Messages, silently fails without it, and either
      // way the token has already been distributed. Tell the user to revoke it,
      // which is the only action that actually helps.
      if (!msg.isDirectMessage) {
        return {
          handled: true,
          reply:
            "`/link` only works in a DM — a token in a channel is visible to everyone here. " +
            "Revoke that token in the web UI and DM me a fresh one.",
        };
      }
      if (!arg) {
        return {
          handled: true,
          reply:
            "Usage: `/link <token>` — mint one in the web UI under Tokens, then paste it here.",
        };
      }
      // The token itself is never echoed back and never logged — only the
      // verification outcome leaves this block.
      const verified = await verifyToken(arg);
      if (!verified) {
        return {
          handled: true,
          reply:
            "That token didn't verify — it may be revoked, mistyped, or truncated. " +
            "Mint a fresh one in the web UI and try again.",
        };
      }
      // CONSUME-ON-LINK (design §2). The token is revoked the moment it is
      // accepted, BEFORE the identity row is written: a link token is a
      // one-time proof of account ownership, not a standing credential. Anyone
      // who later reads it (channel scrollback, a shell history, a leaked
      // backup) would otherwise be able to replay it from their own Discord
      // account and re-point this identity at the victim's user — silently
      // inheriting attribution for everything that account does here.
      // Conditional-and-atomic (revokedAt IS NULL in the WHERE clause), so two
      // racing /link calls with the same token cannot both win.
      if (!(await consumeToken(verified.tokenId))) {
        return {
          handled: true,
          reply:
            "That token has already been used — link tokens are single-use. " +
            "Mint a fresh one in the web UI and try again.",
        };
      }
      await repo.upsertChannelIdentity({
        channel: msg.channel,
        externalUserId: msg.authorId,
        userId: verified.userId,
        label: msg.authorName ?? msg.authorLabel,
      });
      const user = await getUserById(verified.userId);
      return {
        handled: true,
        reply:
          `✅ Linked to **${user?.email ?? `user #${verified.userId}`}**. ` +
          "Everything we do together is yours in the web UI from now on. " +
          "That token is now used up (I revoked it), so it can't be replayed — " +
          "mint a new one if you ever need to re-link.",
      };
    }

    case "whoami":
    case "session": {
      const persona = await repo.getPersona(personaId);
      const identity = await repo.getChannelIdentity(msg.channel, msg.authorId);
      const user = identity ? await getUserById(identity.userId) : undefined;
      // The linked email is personal data, so it is only ever printed in a DM.
      // In a guild the answer is just linked / not linked — the slash-command
      // path also defers /whoami ephemerally, but a TEXT `/whoami` typed in a
      // channel is an ordinary public message and would put the address in the
      // room's scrollback.
      const account = identity
        ? msg.isDirectMessage
          ? `**${user?.email ?? `user #${identity.userId}`}**`
          : "linked (DM me `/whoami` to see which account)"
        : "not linked — `/link <token>` in a DM to attribute your work";

      const lines = [
        `I'm **${persona?.name ?? personaId}** (persona \`${personaId}\`).`,
        `You: ${msg.authorLabel} · account: ${account}`,
      ];

      const id = await currentRunId(msg.channel, msg.externalId, personaId);
      if (!id) {
        lines.push("This thread has no conversation yet — just send a message.");
        return { handled: true, reply: lines.join("\n") };
      }
      const run = await runs.getRun(id);
      const model = (await chat.getChat(id))?.model ?? run?.model ?? config.defaultModel;
      lines.push(
        `This thread: run #${id}${run?.taskId ? ` · task ${taskLink(run.taskId)}` : ""}` +
          `${run?.planId ? ` · plan ${planLink(run.planId)}` : ""} · model \`${model}\``
      );
      lines.push(`Details: ${runLink(id)}`);
      return { handled: true, reply: lines.join("\n") };
    }

    case "help":
      return { handled: true, reply: HELP };

    default:
      return { handled: false }; // unknown slash → fall through to the agent
  }
}
