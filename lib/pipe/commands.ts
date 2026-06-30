// lib/pipe/commands.ts
//
// Slash-command interception — claude-pipe style. The agent loop calls
// handleCommand() before any LLM turn; a handled command replies instantly
// (no tokens spent). Unknown slashes fall through and are treated as a prompt.

import * as chat from "@/lib/chat";
import * as runs from "@/lib/runs";
import { currentRunId, getOrCreateRun, resetThread } from "./session-store";
import type { InboundMessage, PipeConfig } from "./types";

export interface CommandResult {
  /** false => not a known command; the loop treats the text as a prompt. */
  handled: boolean;
  /** Immediate reply to send (no agent turn). */
  reply?: string;
}

const HELP = [
  "**Commands**",
  "`/stop` — interrupt the agent's current turn (aliases: `/cancel`, `/abort`)",
  "`/status` — show whether the agent is working right now",
  "`/new` or `/reset` — start a fresh conversation",
  "`/model <provider/id>` — set the model (e.g. `anthropic/claude-sonnet-4-6`)",
  "`/whoami` or `/session` — show the current run id, model, and repo",
  "`/help` — this message",
  "Anything else is sent to the agent.",
].join("\n");

export async function handleCommand(
  msg: InboundMessage,
  config: PipeConfig
): Promise<CommandResult> {
  const [cmd, ...rest] = msg.text.trim().slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd.toLowerCase()) {
    case "stop":
    case "cancel":
    case "abort": {
      // Interrupt the in-flight turn for this conversation. The /stop message is
      // dispatched concurrently with the running turn (the agent loop is
      // fire-and-forget per message), so this aborts the live runner directly —
      // it doesn't queue behind the turn it's trying to kill.
      const id = currentRunId(msg.channel, msg.externalId);
      if (!id) {
        return { handled: true, reply: "Nothing to stop — no active conversation yet." };
      }
      const stopped = runs.interrupt(id);
      return {
        handled: true,
        reply: stopped
          ? `⏹️ Stopped run #${id}. Send another message to continue, or \`/new\` to start fresh.`
          : `Nothing to stop — run #${id} isn't working on anything right now.`,
      };
    }

    case "status": {
      const id = currentRunId(msg.channel, msg.externalId);
      if (!id) {
        return { handled: true, reply: "No active conversation yet — send a message to start one." };
      }
      const model = chat.getChat(id)?.model ?? config.defaultModel;
      return {
        handled: true,
        reply: runs.isLive(id)
          ? `🟢 Working on run #${id} (model \`${model}\`). Send \`/stop\` to interrupt.`
          : `⚪ Idle — run #${id}, model \`${model}\`. Send a message to start a turn.`,
      };
    }

    case "new":
    case "reset": {
      resetThread(msg.channel, msg.externalId);
      const runId = getOrCreateRun(msg.channel, msg.externalId, { model: config.defaultModel });
      return { handled: true, reply: `Started a fresh conversation (run #${runId}).` };
    }

    case "model": {
      if (!arg) {
        const id = currentRunId(msg.channel, msg.externalId);
        const m = (id && chat.getChat(id)?.model) || config.defaultModel;
        return {
          handled: true,
          reply: `Current model: \`${m}\`. Usage: \`/model provider/id\``,
        };
      }
      const runId = getOrCreateRun(msg.channel, msg.externalId, { model: config.defaultModel });
      chat.updateChatSettings(runId, { model: arg }); // expects a provider-qualified id
      return { handled: true, reply: `Model set to \`${arg}\` for run #${runId}.` };
    }

    case "whoami":
    case "session": {
      const id = currentRunId(msg.channel, msg.externalId);
      if (!id) {
        return { handled: true, reply: "No active conversation yet — just send a message." };
      }
      const c = chat.getChat(id);
      return {
        handled: true,
        reply:
          `Run #${id} · model \`${c?.model ?? config.defaultModel}\` · repo \`${c?.repoId ?? "(default)"}\`\n` +
          `Web: /runs/${id}\nYou: ${msg.authorLabel}`,
      };
    }

    case "help":
      return { handled: true, reply: HELP };

    default:
      return { handled: false }; // unknown slash → fall through to the agent
  }
}
