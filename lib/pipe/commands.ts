// lib/pipe/commands.ts
//
// Slash-command interception — claude-pipe style. The agent loop calls
// handleCommand() before any LLM turn; a handled command replies instantly
// (no tokens spent). Unknown slashes fall through and are treated as a prompt.

import * as chat from "@/lib/chat";
import { isLeaseLive } from "@/lib/run-liveness";
import * as runs from "@/lib/runs";
import { currentRunId, getOrCreateRun, resetThread } from "./session-store";
import type { InboundMessage, PipeConfig } from "./types";

export interface CommandResult {
  /** false => not a known command; the loop treats the text as a prompt. */
  handled: boolean;
  /** Immediate reply to send (no agent turn). */
  reply?: string;
}

// A turn may run either in this (bridge) process — tracked by runs.isLive via the
// in-process runners map — or in the web server process, which shares the SQLite
// DB. The web turn is invisible to isLive/interrupt, so /status and /stop also
// consult the DB liveness lease: an active status with a fresh heartbeat.

/** True when the run holds a live DB lease (active status + fresh heartbeat). */
function leaseLive(run: runs.RunRow | null): boolean {
  return run != null && isLeaseLive(run);
}

const HELP = [
  "**Commands**",
  "`/stop` — interrupt the agent's current turn (aliases: `/cancel`, `/abort`)",
  "`/status` — show whether the agent is working right now",
  "`/new` or `/reset` — start a fresh conversation",
  "`/model <provider/id>` — set the model (e.g. `openai/gpt-5.6-sol`)",
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
      const id = await currentRunId(msg.channel, msg.externalId);
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
      const id = await currentRunId(msg.channel, msg.externalId);
      if (!id) {
        return { handled: true, reply: "No active conversation yet — send a message to start one." };
      }
      const run = await runs.getRun(id);
      const model = (await chat.getChat(id))?.model ?? run?.model ?? config.defaultModel;
      // A turn started here → we can stop it. A turn started in the web process
      // shows a live DB lease but no local runner → report it, but be honest
      // that /stop won't reach it. Otherwise the run is idle.
      if (runs.isLive(id)) {
        return {
          handled: true,
          reply: `🟢 Working on run #${id} (model \`${model}\`). Send \`/stop\` to interrupt.`,
        };
      }
      if (leaseLive(run)) {
        return {
          handled: true,
          reply: `🟢 Working on run #${id} (model \`${model}\`) in another process (e.g. the web app). \`/stop\` can only interrupt turns started here.`,
        };
      }
      return {
        handled: true,
        reply: `⚪ Idle — run #${id}, model \`${model}\`. Send a message to start a turn.`,
      };
    }

    case "new":
    case "reset": {
      await resetThread(msg.channel, msg.externalId);
      const runId = await getOrCreateRun(msg.channel, msg.externalId, { model: config.defaultModel });
      return { handled: true, reply: `Started a fresh conversation (run #${runId}).` };
    }

    case "model": {
      if (!arg) {
        const id = await currentRunId(msg.channel, msg.externalId);
        const m = (id && (await chat.getChat(id))?.model) || config.defaultModel;
        return {
          handled: true,
          reply: `Current model: \`${m}\`. Usage: \`/model provider/id\``,
        };
      }
      const runId = await getOrCreateRun(msg.channel, msg.externalId, { model: config.defaultModel });
      await chat.updateChatSettings(runId, { model: arg }); // expects a provider-qualified id
      return { handled: true, reply: `Model set to \`${arg}\` for run #${runId}.` };
    }

    case "whoami":
    case "session": {
      const id = await currentRunId(msg.channel, msg.externalId);
      if (!id) {
        return { handled: true, reply: "No active conversation yet — just send a message." };
      }
      const c = await chat.getChat(id);
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
