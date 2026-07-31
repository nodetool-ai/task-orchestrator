// The Discord adapter's boundary rules — everything that decides whether a
// message becomes an InboundMessage at all, and how a reply gets back out.
//
// Three M4-review findings live here:
//   F2  where a persona listens: DM / @-mention / its own thread, silence
//       otherwise — the rule that keeps two bots in one channel from both
//       answering an unaddressed message.
//   F4  the interaction claim: a deferred slash reply belongs to exactly the
//       turn that produced it, never to whoever writes first in that channel.
//   F1  ❌ as a pre-queue interrupt, routed through the one /stop path.
//   F8  a slash command in a guild parent channel means the auto-thread below.
//
// Style: fake Message/Interaction/Reaction shapes and direct calls into the
// adapter's private handlers — never a live gateway. The adapter's own
// discord.js Client is replaced with a stub (no login, no network).

import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it } from "vitest";

import { DiscordChannel } from "../lib/pipe/channels/discord";
import type { InboundMessage, PersonaBotConfig } from "../lib/pipe/types";

const BOT = "bot-aria";
const OTHER_BOT = "bot-rex";

interface Harness {
  chan: DiscordChannel;
  inbound: InboundMessage[];
  /** Plain channel sends: { externalId, text }. */
  sends: { externalId: string; text: string }[];
  /** Edits of messages posted by the adapter (draft updates). */
  edits: string[];
}

function harness(over: Partial<PersonaBotConfig> = {}, selfId = BOT): Harness {
  const cfg: PersonaBotConfig = {
    personaId: "aria",
    token: "t",
    allowedUsers: ["u1"],
    allowedChannels: [],
    ...over,
  };
  const chan = new DiscordChannel(cfg);
  const inbound: InboundMessage[] = [];
  const sends: { externalId: string; text: string }[] = [];
  const edits: string[] = [];
  chan.onMessage((m) => {
    inbound.push(m);
  });
  const fakeClient = {
    user: { id: selfId },
    channels: {
      async fetch(externalId: string) {
        return {
          isTextBased: () => true,
          async send(text: string) {
            sends.push({ externalId, text });
            return {
              async edit(next: string) {
                edits.push(next);
              },
            };
          },
        };
      },
    },
  };
  (chan as unknown as { client: unknown }).client = fakeClient;
  return { chan, inbound, sends, edits };
}

/** Reach the adapter's gateway handler directly. */
function deliver(chan: DiscordChannel, message: unknown): Promise<void> {
  return (
    chan as unknown as { onDiscordMessage(m: unknown): Promise<void> }
  ).onDiscordMessage(message);
}

function deliverInteraction(chan: DiscordChannel, i: unknown): Promise<void> {
  return (chan as unknown as { onInteraction(i: unknown): Promise<void> }).onInteraction(i);
}

function deliverReaction(chan: DiscordChannel, r: unknown, u: unknown): Promise<void> {
  return (
    chan as unknown as { onReactionAdd(r: unknown, u: unknown): Promise<void> }
  ).onReactionAdd(r, u);
}

interface MessageOpts {
  content?: string;
  mentions?: string[];
  channelId?: string;
  guildId?: string | null;
  thread?: { ownerId?: string; parentId?: string };
  authorId?: string;
}

const startedThreads: { name: string }[] = [];

function fakeMessage(o: MessageOpts = {}) {
  const channelId = o.channelId ?? (o.thread ? "thread-1" : "chan-1");
  const channel = o.thread
    ? {
        id: channelId,
        isThread: () => true,
        type: ChannelType.PublicThread,
        ownerId: o.thread.ownerId,
        parentId: o.thread.parentId ?? "chan-1",
        async fetch() {
          return { ownerId: o.thread?.ownerId };
        },
      }
    : {
        id: channelId,
        isThread: () => false,
        type: o.guildId === null ? ChannelType.DM : ChannelType.GuildText,
      };
  return {
    author: { id: o.authorId ?? "u1", bot: false, username: "tester" },
    content: o.content ?? "hello",
    channelId,
    guildId: o.guildId === undefined ? "g1" : o.guildId,
    mentions: { users: new Set(o.mentions ?? []) },
    channel,
    async startThread(opts: { name: string }) {
      startedThreads.push(opts);
      return { id: "thread-1" };
    },
  };
}

interface FakeInteraction {
  id: string;
  commandName: string;
  channelId: string;
  guildId: string | null;
  edits: string[];
  deferred: { ephemeral?: boolean }[];
  ephemeralRejections: string[];
}

function fakeInteraction(
  id: string,
  commandName: string,
  over: { channelId?: string; guildId?: string | null; isThread?: boolean; args?: string[] } = {}
) {
  const edits: string[] = [];
  const deferred: { ephemeral?: boolean }[] = [];
  const ephemeralRejections: string[] = [];
  return {
    id,
    commandName,
    channelId: over.channelId ?? "chan-1",
    guildId: over.guildId === undefined ? "g1" : over.guildId,
    user: { id: "u1", username: "tester" },
    options: { data: (over.args ?? []).map((value) => ({ value })) },
    channel: { isThread: () => over.isThread ?? false },
    async deferReply(opts: { ephemeral?: boolean }) {
      deferred.push(opts ?? {});
    },
    async reply(opts: { content: string }) {
      ephemeralRejections.push(opts.content);
    },
    async editReply(text: string) {
      edits.push(text);
    },
    edits,
    deferred,
    ephemeralRejections,
  } as unknown as FakeInteraction & Record<string, unknown>;
}

beforeEach(() => {
  startedThreads.length = 0;
});

// ──────────────────────────────────────────────────────────
// F2 — where a persona listens
// ──────────────────────────────────────────────────────────

describe("guild trigger rules (PRD §6)", () => {
  it("ignores an unmentioned guild-channel message, silently and without threading", async () => {
    const { chan, inbound, sends } = harness();
    await deliver(chan, fakeMessage({ content: "team, what's the plan?" }));
    expect(inbound).toEqual([]);
    expect(sends).toEqual([]);
    expect(startedThreads).toEqual([]); // no thread spawned for a message not for us
  });

  it("processes a mentioned guild-channel message and auto-threads it", async () => {
    const { chan, inbound } = harness();
    await deliver(
      chan,
      fakeMessage({ content: `<@${BOT}> ship the dark mode fix`, mentions: [BOT] })
    );
    expect(inbound).toHaveLength(1);
    expect(inbound[0].externalId).toBe("thread-1"); // auto-threaded
    expect(inbound[0].text).toBe("ship the dark mode fix"); // mention stripped
    expect(inbound[0].isDirectMessage).toBe(false);
    expect(startedThreads).toHaveLength(1);
  });

  it("processes any message in a thread it owns, with no re-mention", async () => {
    const { chan, inbound } = harness();
    await deliver(chan, fakeMessage({ content: "and add tests", thread: { ownerId: BOT } }));
    expect(inbound).toHaveLength(1);
    expect(inbound[0].externalId).toBe("thread-1");
    expect(inbound[0].text).toBe("and add tests");
    expect(startedThreads).toEqual([]); // already in a thread — no nesting
  });

  it("ignores an unmentioned message in ANOTHER bot's thread", async () => {
    const { chan, inbound } = harness();
    await deliver(chan, fakeMessage({ content: "sounds good", thread: { ownerId: OTHER_BOT } }));
    expect(inbound).toEqual([]);
  });

  it("still answers inside another bot's thread when explicitly mentioned", async () => {
    const { chan, inbound } = harness();
    await deliver(
      chan,
      fakeMessage({
        content: `<@${BOT}> what do you think?`,
        mentions: [BOT],
        thread: { ownerId: OTHER_BOT },
      })
    );
    expect(inbound).toHaveLength(1);
    expect(inbound[0].text).toBe("what do you think?");
  });

  it("falls back to fetching the thread when ownerId isn't cached", async () => {
    const { chan, inbound } = harness();
    const m = fakeMessage({ content: "carry on", thread: {} });
    (m.channel as { ownerId?: string }).ownerId = undefined;
    (m.channel as { fetch: () => Promise<{ ownerId: string }> }).fetch = async () => ({
      ownerId: BOT,
    });
    await deliver(chan, m);
    expect(inbound).toHaveLength(1);
  });

  it("always processes DMs, mention or not", async () => {
    const { chan, inbound } = harness();
    await deliver(chan, fakeMessage({ content: "hi", guildId: null, channelId: "dm-1" }));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ externalId: "dm-1", isDirectMessage: true, text: "hi" });
  });

  it("keeps two bots in one channel from double-answering", async () => {
    const aria = harness({ personaId: "aria" }, BOT);
    const rex = harness({ personaId: "rex" }, OTHER_BOT);

    // Nobody addressed: neither answers.
    const unaddressed = () => fakeMessage({ content: "morning all" });
    await deliver(aria.chan, unaddressed());
    await deliver(rex.chan, unaddressed());
    expect(aria.inbound).toEqual([]);
    expect(rex.inbound).toEqual([]);

    // One addressed: only that one answers.
    const oneMention = () =>
      fakeMessage({ content: `<@${BOT}> status?`, mentions: [BOT] });
    await deliver(aria.chan, oneMention());
    await deliver(rex.chan, oneMention());
    expect(aria.inbound).toHaveLength(1);
    expect(rex.inbound).toEqual([]);

    // Both addressed: both answer (PRD §10 — each answers only if mentioned).
    const bothMentioned = () =>
      fakeMessage({ content: `<@${BOT}> <@${OTHER_BOT}> thoughts?`, mentions: [BOT, OTHER_BOT] });
    await deliver(aria.chan, bothMentioned());
    await deliver(rex.chan, bothMentioned());
    expect(aria.inbound).toHaveLength(2);
    expect(rex.inbound).toHaveLength(1);
  });

  it("stays silent for a non-allowlisted user in a guild even when mentioned", async () => {
    const { chan, inbound, sends } = harness();
    await deliver(
      chan,
      fakeMessage({ content: `<@${BOT}> hi`, mentions: [BOT], authorId: "stranger" })
    );
    expect(inbound).toEqual([]);
    expect(sends).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────
// F4 — the interaction claim
// ──────────────────────────────────────────────────────────

describe("slash-command interaction claims", () => {
  it("hands each command its own deferred reply, even two in one channel", async () => {
    const { chan, sends } = harness();
    // Stand in for the agent loop: reply to each turn with its own text, using
    // the claim that arrived with it.
    chan.onMessage((m) => {
      void chan.send(m.externalId, `answer to ${m.text}`, m.replyToken);
    });

    const a = fakeInteraction("i-1", "status");
    const b = fakeInteraction("i-2", "help");
    await deliverInteraction(chan, a);
    await deliverInteraction(chan, b);
    await new Promise((r) => setTimeout(r, 0));

    expect(a.edits).toEqual(["answer to /status"]);
    expect(b.edits).toEqual(["answer to /help"]);
    expect(sends).toEqual([]); // neither answer leaked into the channel
  });

  it("never lets an ordinary message turn consume a pending command interaction", async () => {
    const { chan, sends } = harness();
    const turns: InboundMessage[] = [];
    chan.onMessage((m) => turns.push(m));

    const i = fakeInteraction("i-1", "status", { guildId: null });
    await deliverInteraction(chan, i);
    // ...and a DM message lands in the same channel while the command is still
    // deferred. Its reply must be an ordinary send, not the command's reply.
    await deliver(chan, fakeMessage({ content: "unrelated", guildId: null, channelId: "chan-1" }));

    const message = turns.find((t) => t.text === "unrelated")!;
    expect(message.replyToken).toBeUndefined();
    await chan.send(message.externalId, "message answer", message.replyToken);
    expect(i.edits).toEqual([]);
    expect(sends).toEqual([{ externalId: "chan-1", text: "message answer" }]);

    // The command's own reply still works afterwards.
    const command = turns.find((t) => t.text === "/status")!;
    await chan.send(command.externalId, "command answer", command.replyToken);
    expect(i.edits).toEqual(["command answer"]);
  });

  it("spends a claim exactly once — a second write goes to the channel", async () => {
    const { chan, sends } = harness();
    const i = fakeInteraction("i-1", "status");
    await deliverInteraction(chan, i);
    await chan.send("chan-1", "first", "i-1");
    await chan.send("chan-1", "second", "i-1"); // e.g. an overflow chunk
    expect(i.edits).toEqual(["first"]);
    expect(sends).toEqual([{ externalId: "chan-1", text: "second" }]);
  });

  it("streams a draft through the interaction, then finalizes it", async () => {
    const { chan, sends } = harness();
    const i = fakeInteraction("i-1", "frobnicate"); // unknown slash → a real turn
    await deliverInteraction(chan, i);
    const draft = await chan.openDraft("chan-1", "…", "i-1");
    await draft.update("partial");
    await draft.finalize("done");
    expect(i.edits).toEqual(["…", "partial", "done"]);
    expect(sends).toEqual([]);
  });

  it("falls back to a channel message when the interaction has expired (10062)", async () => {
    const { chan, sends } = harness();
    const i = fakeInteraction("i-1", "status");
    await deliverInteraction(chan, i);
    (i as unknown as { editReply: () => Promise<void> }).editReply = async () => {
      throw Object.assign(new Error("Unknown interaction"), { code: 10062 });
    };
    await chan.send("chan-1", "answer anyway", "i-1");
    expect(sends).toEqual([{ externalId: "chan-1", text: "answer anyway" }]);
  });

  it("falls back to a channel draft when the interaction dies before the first edit", async () => {
    const { chan, sends, edits } = harness();
    const i = fakeInteraction("i-1", "frobnicate");
    await deliverInteraction(chan, i);
    (i as unknown as { editReply: () => Promise<void> }).editReply = async () => {
      throw Object.assign(new Error("already acknowledged"), { code: 40060 });
    };
    const draft = await chan.openDraft("chan-1", "…", "i-1");
    await draft.finalize("done");
    expect(sends).toEqual([{ externalId: "chan-1", text: "…" }]);
    expect(edits).toEqual(["done"]);
  });

  it("re-raises a non-interaction API failure instead of silently rerouting", async () => {
    const { chan } = harness();
    const i = fakeInteraction("i-1", "status");
    await deliverInteraction(chan, i);
    (i as unknown as { editReply: () => Promise<void> }).editReply = async () => {
      throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
    };
    await expect(chan.send("chan-1", "x", "i-1")).rejects.toThrow(/Missing Permissions/);
  });

  it("defers /link and /whoami ephemerally, and other commands publicly", async () => {
    const { chan } = harness();
    const link = fakeInteraction("i-1", "link", { args: ["tot_x"] });
    const whoami = fakeInteraction("i-2", "whoami");
    const status = fakeInteraction("i-3", "status");
    await deliverInteraction(chan, link);
    await deliverInteraction(chan, whoami);
    await deliverInteraction(chan, status);
    expect(link.deferred[0].ephemeral).toBe(true);
    expect(whoami.deferred[0].ephemeral).toBe(true);
    expect(status.deferred[0].ephemeral).toBe(false);
  });

  it("refuses a non-allowlisted invoker without stashing a claim", async () => {
    const { chan, inbound } = harness();
    const i = fakeInteraction("i-1", "status");
    (i as unknown as { user: { id: string; username: string } }).user = {
      id: "stranger",
      username: "nope",
    };
    await deliverInteraction(chan, i);
    expect(inbound).toEqual([]);
    expect(i.ephemeralRejections[0]).toMatch(/not enabled/i);
  });
});

// ──────────────────────────────────────────────────────────
// F8 — slash commands typed in the parent channel
// ──────────────────────────────────────────────────────────

describe("slash commands in a guild parent channel", () => {
  it("targets the bot's most recent auto-thread off that channel", async () => {
    const { chan, inbound } = harness();
    await deliver(chan, fakeMessage({ content: `<@${BOT}> go`, mentions: [BOT] }));
    expect(inbound[0].externalId).toBe("thread-1");

    for (const name of ["stop", "status", "whoami"]) {
      const i = fakeInteraction(`i-${name}`, name);
      await deliverInteraction(chan, i);
    }
    expect(inbound.slice(1).map((m) => m.externalId)).toEqual([
      "thread-1",
      "thread-1",
      "thread-1",
    ]);
  });

  it("leaves non-conversation commands (and DMs) on the invoking channel", async () => {
    const { chan, inbound } = harness();
    await deliver(chan, fakeMessage({ content: `<@${BOT}> go`, mentions: [BOT] }));
    await deliverInteraction(chan, fakeInteraction("i-1", "help"));
    await deliverInteraction(chan, fakeInteraction("i-2", "new"));
    await deliverInteraction(chan, fakeInteraction("i-3", "status", { guildId: null }));
    expect(inbound.slice(1).map((m) => m.externalId)).toEqual(["chan-1", "chan-1", "chan-1"]);
  });

  it("targets the invoking channel when no auto-thread is remembered", async () => {
    const { chan, inbound } = harness();
    await deliverInteraction(chan, fakeInteraction("i-1", "status"));
    expect(inbound[0].externalId).toBe("chan-1");
  });

  it("TODO(M5): a TEXT command in the parent channel still auto-threads (unchanged)", async () => {
    // Documented current behavior, asserted so a future change is deliberate:
    // the parent-channel resolution above covers slash commands only.
    const { chan, inbound } = harness();
    await deliver(chan, fakeMessage({ content: `<@${BOT}> /status`, mentions: [BOT] }));
    expect(inbound[0]).toMatchObject({ externalId: "thread-1", text: "/status" });
  });
});

// ──────────────────────────────────────────────────────────
// F1 — ❌ as a pre-queue interrupt
// ──────────────────────────────────────────────────────────

describe("❌ reaction (pre-queue stop)", () => {
  const botMessage = (over: Record<string, unknown> = {}) => ({
    guildId: null,
    channelId: "dm-1",
    author: { id: BOT },
    channel: { isThread: () => false },
    ...over,
  });
  const reaction = (emoji: string, message: unknown = botMessage()) => ({
    emoji: { name: emoji },
    message,
  });
  const allowlisted = { id: "u1", username: "tester", bot: false };

  it("routes an allowlisted user's ❌ on the bot's message as /stop", async () => {
    const { chan, inbound } = harness();
    await deliverReaction(chan, reaction("❌"), allowlisted);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      text: "/stop",
      externalId: "dm-1",
      authorId: "u1",
      personaId: "aria",
    });
  });

  it("ignores ❌ from a non-allowlisted user", async () => {
    const { chan, inbound } = harness();
    await deliverReaction(chan, reaction("❌"), { id: "stranger", username: "x", bot: false });
    expect(inbound).toEqual([]);
  });

  it("ignores any other emoji", async () => {
    const { chan, inbound } = harness();
    for (const emoji of ["👍", "👎", "👀", "🛑"]) {
      await deliverReaction(chan, reaction(emoji), allowlisted);
    }
    expect(inbound).toEqual([]);
  });

  it("ignores ❌ from a bot (including itself)", async () => {
    const { chan, inbound } = harness();
    await deliverReaction(chan, reaction("❌"), { id: "u1", username: "tester", bot: true });
    expect(inbound).toEqual([]);
  });

  it("ignores ❌ on someone else's message outside the bot's conversations", async () => {
    const { chan, inbound } = harness();
    await deliverReaction(
      chan,
      reaction(
        "❌",
        botMessage({
          guildId: "g1",
          channelId: "chan-1",
          author: { id: "u2" },
          channel: { isThread: () => false },
        })
      ),
      allowlisted
    );
    expect(inbound).toEqual([]);
  });

  it("accepts ❌ on another user's message inside a thread the bot owns", async () => {
    const { chan, inbound } = harness();
    await deliverReaction(
      chan,
      reaction(
        "❌",
        botMessage({
          guildId: "g1",
          channelId: "thread-1",
          author: { id: "u2" },
          channel: { isThread: () => true, ownerId: BOT, parentId: "chan-1", id: "thread-1" },
        })
      ),
      allowlisted
    );
    expect(inbound).toHaveLength(1);
    expect(inbound[0].externalId).toBe("thread-1");
  });

  it("respects the channel allowlist", async () => {
    const { chan, inbound } = harness({ allowedChannels: ["other-chan"] });
    await deliverReaction(
      chan,
      reaction(
        "❌",
        botMessage({ guildId: "g1", channelId: "chan-1", channel: { isThread: () => false } })
      ),
      allowlisted
    );
    expect(inbound).toEqual([]);
  });
});
