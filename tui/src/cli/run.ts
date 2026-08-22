// The non-interactive verbs (PRD §6.5). One async function per verb, all of
// them against an injected client and injected writers, so the suite exercises
// the real code path without a process, a terminal or a server.
//
// The contract every verb keeps:
//   - data on stdout, diagnostics on stderr;
//   - exit 0 ok, 1 the operator's mistake, 2 the server's;
//   - `--json` prints exactly one JSON document (an array where the verb
//     lists), except `tail`, which is a stream and therefore one document per
//     line — a single array could only be closed when the follow ends.

import { ApiError, UnauthorizedError, type OrchClient, type Subscription } from "../api/client.js";
import { ZERO_CURSOR, type MessageRow } from "../api/types.js";
import { buildForest } from "../model/forest.js";
import { appendFrame, frameFromEvent, framesFromMessages, type Frame } from "../model/frames.js";
import { toInboxItems } from "../model/inbox.js";
import { newRunInput, resolvePersona, spawnMessage } from "./commands.js";
import { floorJson, floorRows, floorText, frameJson, frameLine, inboxJson, inboxText, type Speaker } from "./format.js";
import { USAGE, type CliCommand } from "./parse.js";

export type ExitCode = 0 | 1 | 2;

export interface CliIo {
  client: OrchClient;
  /** Both writers take a line without its newline. */
  out(line: string): void;
  err(line: string): void;
  /** Injected so the age column is not a stopwatch in the tests. */
  now?(): number;
  /** `orch tail` follows until this aborts (^c) or the stream ends. */
  signal?: AbortSignal;
}

/** Map a thrown error to an exit code. A 401 is the operator's to fix (wrong
 *  or missing ORCH_TOKEN), so it is a user error; everything else that
 *  reaches here is the server's or the network's. */
export function exitCodeFor(err: unknown): 1 | 2 {
  if (err instanceof UnauthorizedError) return 1;
  if (err instanceof ApiError) return 2;
  return 2;
}

export function errorLine(err: unknown): string {
  if (err instanceof UnauthorizedError) return `unauthorized — ${err.hint}`;
  return err instanceof Error ? err.message : String(err);
}

export async function runCommand(cmd: CliCommand, io: CliIo): Promise<ExitCode> {
  if (cmd.kind === "help") {
    io.out(USAGE);
    return 0;
  }
  if (cmd.kind === "error") {
    io.err(`orch: ${cmd.message}`);
    return 1;
  }
  try {
    switch (cmd.kind) {
      case "floor":
        return await floor(cmd.json, io);
      case "inbox":
        return await inbox(cmd.json, io);
      case "tail":
        return await tail(cmd.id, cmd.json, io);
      case "say":
        return await say(cmd.id, cmd.text, cmd.json, io);
      case "new":
        return await create(cmd.persona, cmd.goal, cmd.json, io);
      case "spawn":
        return await spawn(cmd.id, cmd.persona, cmd.arg, cmd.json, io);
      case "cancel":
        return await cancel(cmd.id, cmd.json, io);
    }
  } catch (err) {
    io.err(`orch: ${errorLine(err)}`);
    return exitCodeFor(err);
  }
}

// ── list verbs ─────────────────────────────────────────────────────────────

async function floor(json: boolean, io: CliIo): Promise<ExitCode> {
  const rows = floorRows(buildForest(await io.client.overview()));
  if (json) {
    io.out(JSON.stringify(floorJson(rows)));
    return 0;
  }
  for (const line of floorText(rows, now(io))) io.out(line);
  return 0;
}

async function inbox(json: boolean, io: CliIo): Promise<ExitCode> {
  const items = toInboxItems(await io.client.inbox());
  if (json) {
    io.out(JSON.stringify(inboxJson(items)));
    return 0;
  }
  for (const line of inboxText(items, now(io))) io.out(line);
  return 0;
}

// ── tail ───────────────────────────────────────────────────────────────────

async function tail(id: number, json: boolean, io: CliIo): Promise<ExitCode> {
  const detail = await io.client.run(id);
  const who: Speaker = { self: id, persona: detail.personaId ?? "agent" };

  // Frames go through appendFrame for the same reason the store does it: the
  // event stream replays from the start of the run while the batch already
  // carries the mirrored copies, and folding is what keeps a resumed tail from
  // printing the same tool call twice.
  let frames: Frame[] = [];
  const write = (f: Frame): void => {
    const next = appendFrame(frames, f);
    const grew = next.length > frames.length;
    frames = next;
    if (!grew) return; // an in-place fold adds detail a one-line view never shows
    const last = next[next.length - 1] as Frame;
    io.out(json ? JSON.stringify(frameJson(last, who)) : frameLine(last, who));
  };

  for (const f of framesFromMessages(detail.messages ?? [])) write(f);
  // Resume past what the batch already showed; events are not in the batch,
  // so their cursor stays at zero.
  const msgId = (detail.messages ?? []).reduce((m: number, r: MessageRow) => Math.max(m, r.id), 0);

  return await new Promise<ExitCode>((resolve) => {
    // `sub` is assigned after the handlers are built, and a fake (or a very
    // fast) stream can end inside the call that creates it — so closing is
    // driven off `done` rather than off having a subscription in hand.
    let sub: Subscription | null = null;
    let done = false;
    const finish = (code: ExitCode): void => {
      if (done) return;
      done = true;
      io.signal?.removeEventListener("abort", onAbort);
      sub?.close();
      resolve(code);
    };
    const onAbort = (): void => finish(0);

    sub = io.client.runEvents(id, { msgId, evtId: ZERO_CURSOR.evtId }, {
      onMessage: (m) => {
        for (const f of framesFromMessages([m])) write(f);
      },
      onEvent: (frame) => {
        const f = frameFromEvent(id, frame);
        if (f) write(f);
      },
      onEnd: () => finish(0),
      onError: (err) => {
        // The client retries everything but a 401, and a retry is not news:
        // one line on stderr, and the follow continues.
        io.err(`orch: ${errorLine(err)}`);
        if (err instanceof UnauthorizedError) finish(1);
      },
    });

    if (io.signal?.aborted) return finish(0);
    io.signal?.addEventListener("abort", onAbort);
  });
}

// ── write verbs ────────────────────────────────────────────────────────────
// Text mode prints nothing when there is nothing to read back: silence is
// success, and a chatty "sent." on stdout would corrupt a pipe. `--json` still
// answers, so a script can check one shape for every verb.

async function say(id: number, text: string, json: boolean, io: CliIo): Promise<ExitCode> {
  await io.client.sendMessage(id, text);
  if (json) io.out(JSON.stringify({ ok: true, runId: id, text }));
  return 0;
}

async function spawn(id: number, persona: string, arg: string, json: boolean, io: CliIo): Promise<ExitCode> {
  // T-tui-08: never create a child run here. The orchestrator owns the spawn
  // tool; this is a user turn asking it to use it.
  const text = spawnMessage(persona, arg);
  await io.client.sendMessage(id, text);
  if (json) io.out(JSON.stringify({ ok: true, runId: id, text }));
  return 0;
}

async function create(persona: string, goal: string, json: boolean, io: CliIo): Promise<ExitCode> {
  // A cold or refused persona list must not block a run: resolvePersona passes
  // the typed name straight through when it has nothing to check against.
  const personas = await io.client.personas().catch(() => []);
  const found = resolvePersona(personas, persona);
  if (found.id === null) {
    io.err(`orch: ${found.notice}`);
    return 1;
  }
  const row = personas.find((p) => p.id === found.id) ?? null;
  const created = await io.client.createRun(newRunInput(goal, found.id, row));
  io.out(json ? JSON.stringify({ id: created.id, personaId: created.personaId, goal: created.goal, status: created.status }) : String(created.id));
  return 0;
}

async function cancel(id: number, json: boolean, io: CliIo): Promise<ExitCode> {
  // Cancel cascades to descendants server-side; the confirm the TUI asks for
  // is a keyboard affordance, not a rule — a scripted cancel means it.
  const row = await io.client.cancelRun(id);
  if (json) io.out(JSON.stringify({ ok: true, id: row.id, status: row.status }));
  return 0;
}

function now(io: CliIo): number {
  return io.now ? io.now() : Date.now();
}
