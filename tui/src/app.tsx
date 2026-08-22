import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { OrchClient } from "./api/client.js";
import { confirmLine, liveKids, nextInCycle, openUrlFor, parseBudget, resolvePersona, spawnMessage } from "./cli/commands.js";
import { openInBrowser } from "./cli/open.js";
import { floorGroups } from "./model/forest.js";
import { filterPalette } from "./model/palette.js";
import { useOrch } from "./store.js";
import { C, GlyphProvider, Hair, useGlyphs } from "./theme.js";
import { ChatHeader, Transcript } from "./views/chat.js";
import { Floor } from "./views/floor.js";
import { Inbox } from "./views/inbox.js";
import { Palette } from "./views/palette.js";
import { Roster } from "./views/roster.js";
import { Prompt, matchCommands } from "./views/prompt.js";
import { RAIL_MIN_COLS, cursorWindow, paletteHeight, paletteRows, screenLayout } from "./views/layout.js";

type View = "chat" | "floor" | "inbox" | "palette";

// Not wired yet: /say is an M3 CLI verb with no cockpit form. It answers
// honestly rather than pretending to work.
const LATER_COMMANDS = new Set(["/say"]);

const DEFAULT_URL = "http://localhost:3000";

// ── Pure helpers ───────────────────────────────────────────────────────────
// There is no component test harness here, so every decision that is not
// about painting lives in a function that can be called from a test. They now
// live one directory down (src/cli/), where the non-interactive verbs can
// reach them without importing Ink, and are re-exported here because this is
// the module the cockpit and its tests have always imported them from.

export {
  budgetLabel,
  confirmLine,
  liveKids,
  newRunInput,
  nextInCycle,
  openCommand,
  openUrlFor,
  parseBudget,
  resolvePersona,
  spawnMessage,
  type Budget,
  type PersonaRef,
} from "./cli/commands.js";
export { parseArgv, takeGlobalFlags, type Cli } from "./cli/parse.js";
export { glyphs, type Glyphs } from "./theme.js";

// ── The cockpit ────────────────────────────────────────────────────────────

export interface AppProps {
  client: OrchClient;
  initial?: number | null;
  /** Where the server lives, so `o` can build a run url. */
  baseUrl?: string;
  /** Injected so the suite never spawns a browser. */
  openUrl?: (url: string) => Promise<void> | void;
  ascii?: boolean;
}

export function App({ client, initial, baseUrl, openUrl, ascii }: AppProps) {
  return (
    <GlyphProvider ascii={ascii === true}>
      <Cockpit client={client} initial={initial} baseUrl={baseUrl} openUrl={openUrl} />
    </GlyphProvider>
  );
}

// Split from App so every view below — and the cockpit's own key handling —
// reads the glyph table out of the context rather than off a prop.
function Cockpit({ client, initial, baseUrl, openUrl }: Omit<AppProps, "ascii">) {
  const { exit } = useApp();
  const g = useGlyphs();
  const base = baseUrl ?? process.env.ORCH_URL ?? DEFAULT_URL;
  const launch = openUrl ?? openInBrowser;
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 100;
  const rows = stdout.rows ?? 30;

  const s = useOrch(client, initial == null ? {} : { current: initial });

  const [view, setView] = useState<View>("chat");
  const [input, setInput] = useState("");
  const [pq, setPq] = useState("");
  const [cursor, setCursor] = useState(0);
  const [trace, setTrace] = useState(false);
  const [scrollBack, setScrollBack] = useState(0);
  const [rail, setRail] = useState(cols >= RAIL_MIN_COLS);
  const [notice, setNotice] = useState<string | null>(null);
  // The run a message is addressed to (`tab`), and a pending cancel awaiting
  // its second keystroke. Both are cleared by `esc`, in that order.
  const [to, setTo] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ id: number; kids: number } | null>(null);

  const run = s.current === null ? null : (s.forest.byId(s.current) ?? null);

  // Every width and height in one arithmetic (views/layout.ts), because the
  // transcript is sized from what the prompt leaves over and an under-count
  // here over-draws the screen. `help` and `pending` are what <Prompt> is
  // about to paint above the composer.
  const pending = s.inbox.length > 0 && to === null;
  const screen = screenLayout(cols, rows, { rail, help: matchCommands(input).length, pending });
  const { railW, mainW, bodyH } = screen;

  const floorRows = useMemo(() => {
    const { live, rest } = floorGroups(s.forest, g);
    return [...live, ...rest];
  }, [s.forest, g]);
  const paletteItems = useMemo(() => filterPalette(s.palette, pq), [s.palette, pq]);

  // Warm, so `/new implementor …` can be validated the moment it is typed.
  useEffect(() => s.actions.ensurePersonas(), [s.actions]);

  const open = (id: number) => {
    if (id === s.current) return setView("chat");
    s.actions.select(id);
    setScrollBack(0);
    setView("chat");
  };

  const go = (next: View) => {
    setCursor(0);
    setNotice(null);
    if (next === "palette") {
      setPq("");
      s.actions.ensurePalette();
    }
    setView(view === next ? "chat" : next);
  };

  // `↵` on a palette row. A task resolves to its run through the forest
  // (run.taskId), not GET /api/tasks/:id/attached-run: the overview we already
  // hold answers it without a round trip.
  const openPaletteItem = (i: number) => {
    const it = paletteItems[i];
    setView("chat");
    if (!it) return;
    if (it.kind === "run" && it.runId !== undefined) return open(it.runId);
    if (it.kind === "task") {
      const id = s.actions.runForTask(it.id);
      if (id !== null) return open(id);
      setNotice(`${it.id} · no run attached yet`);
      return;
    }
    setNotice(`${it.id} · ${it.label}`);
  };

  // Cancel is the one destructive key in the cockpit, so a subtree with live
  // children costs a second keystroke; a lone run goes straight through.
  const cancel = (id: number, key: string) => {
    const kids = liveKids(s.forest.subtreeOf(id), id);
    if (kids > 0 && confirm?.id !== id) {
      setConfirm({ id, kids });
      return setNotice(confirmLine(id, kids, key));
    }
    setConfirm(null);
    setNotice(`cancelling #${id}…`);
    void s.actions.cancelRun(id);
  };

  // `o` from the floor and from needs-you. The PR is what an operator wants
  // when there is one; the run page is the honest fallback, not an error.
  const browse = (target: { id: number; prUrl: string | null }) => {
    const url = openUrlFor(target, base);
    setNotice(`opening ${url}`);
    void (async () => launch(url))().catch(() => setNotice(`could not open a browser · ${url}`));
  };

  const say = (text: string, target: number | null) => {
    if (target === null && s.current === null) return setNotice("no run open · ^k to jump, or /new <persona> <goal>");
    setTo(null);
    setNotice(null);
    void s.actions.send(text, target).catch(() => setNotice("send failed"));
  };

  const submit = () => {
    const text = input.trim();
    setInput("");
    // A bare `↵` under a cancel confirm is the confirmation.
    if (!text) {
      if (confirm) return cancel(confirm.id, "↵");
      return;
    }
    setConfirm(null);
    if (!text.startsWith("/")) return say(text, to);

    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "/floor":
        return go(view === "floor" ? "chat" : "floor");
      case "/inbox":
        return go(view === "inbox" ? "chat" : "inbox");
      case "/open": {
        const id = Number(arg.replace("#", ""));
        if (!Number.isInteger(id) || id <= 0) return setNotice(`/open #id — not "${arg}"`);
        // Deliberately not gated on forest.byId: a run created seconds ago is
        // not in the overview snapshot yet, and select() can still open it.
        setNotice(null);
        return open(id);
      }
      case "/new": {
        const [who, ...goalWords] = rest;
        const goal = goalWords.join(" ").trim();
        const p = resolvePersona(s.personas, who ?? "");
        if (p.id === null) return setNotice(p.notice);
        if (!goal) return setNotice(`/new ${p.id} <goal>`);
        setNotice(`starting ${p.id}…`);
        void s.actions
          .newRun(p.id, goal)
          .then((id) => {
            if (id === null) return setNotice(`could not start a ${p.id} run`);
            setScrollBack(0);
            setView("chat");
            setNotice(null);
          })
          .catch(() => setNotice(`could not start a ${p.id} run`));
        return;
      }
      case "/spawn": {
        const [who, ...goalWords] = rest;
        const what = goalWords.join(" ").trim();
        if (!who || !what) return setNotice("/spawn <persona> <goal|T-id>");
        if (s.current === null) return setNotice("no run open · /spawn asks the run you are in");
        return say(spawnMessage(who, what), null);
      }
      case "/model": {
        const id = arg.trim();
        if (s.current === null) return setNotice("no run open · /model retunes the run you are in");
        if (!id) return setNotice("/model <id> — e.g. /model claude-sonnet-4-5");
        setNotice(`model → ${id}…`);
        void s.actions
          .configureRun(s.current, { model: id })
          .then((ok) => setNotice(ok ? `model → ${id}` : `could not set the model to ${id}`));
        return;
      }
      case "/budget": {
        if (s.current === null) return setNotice("no run open · /budget caps the run you are in");
        const b = parseBudget(arg);
        if (b.budget === null) return setNotice(b.notice);
        // One command, two columns: a dollar cap and a turn cap are separate
        // limits on the run, so setting one leaves the other alone.
        const patch =
          b.budget.usd === undefined
            ? { budgetMaxTurns: b.budget.turns }
            : { budgetMaxUsd: b.budget.usd };
        const said = b.budget.usd === undefined ? `${b.budget.turns} turns` : `$${b.budget.usd}`;
        setNotice(`budget → ${said}…`);
        void s.actions
          .configureRun(s.current, patch)
          .then((ok) => setNotice(ok ? `budget → ${said}` : `could not cap #${s.current} at ${said}`));
        return;
      }
      case "/cancel": {
        if (s.current === null) return setNotice("no run open");
        return cancel(s.current, "↵");
      }
      case "/trace":
        setTrace((t) => !t);
        return setNotice(`tool trace ${trace ? "off" : "on"}`);
      case "/quit":
        return exit();
      default:
        return setNotice(
          LATER_COMMANDS.has(cmd ?? "") ? `${cmd} is not wired yet` : `${cmd}: unknown command`,
        );
    }
  };

  useInput((ch, key) => {
    // Global chords (PRD §6.3).
    if (key.ctrl && ch === "c") return exit();
    if (key.ctrl && ch === "k") return go("palette");
    if (key.ctrl && ch === "f") return go("floor");
    if (key.ctrl && ch === "n") return go("inbox");
    if (key.ctrl && ch === "b") return setRail((r) => !r);
    if (key.ctrl && ch === "o") return setTrace((t) => !t);

    if (view === "palette") {
      if (key.escape) return setView("chat");
      if (key.return) return openPaletteItem(cursor);
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(paletteItems.length - 1, c + 1));
      if (key.backspace || key.delete) {
        setCursor(0);
        return setPq((q) => q.slice(0, -1));
      }
      if (ch && !key.ctrl && !key.meta) {
        setCursor(0);
        setPq((q) => q + ch);
      }
      return;
    }

    if (view === "floor") {
      if (key.escape) {
        if (confirm) {
          setConfirm(null);
          return setNotice(null);
        }
        return setView("chat");
      }
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(floorRows.length - 1, c + 1));
      if (key.return) {
        const row = floorRows[cursor];
        if (row) open(row.run.id);
        return;
      }
      if (ch === "c") {
        const row = floorRows[cursor];
        if (!row) return;
        return cancel(row.run.id, "c");
      }
      if (ch === "o") {
        const row = floorRows[cursor];
        if (!row) return;
        return browse(row.run);
      }
      // New agent: the composer already knows how to start one, so `n` hands
      // the keyboard back with the command half typed.
      if (ch === "n") {
        setView("chat");
        setInput("/new ");
        return setNotice("/new <persona> <goal>");
      }
      return;
    }

    if (view === "inbox") {
      if (key.escape) return setView("chat");
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(s.inbox.length - 1, c + 1));
      if (key.return) {
        const it = s.inbox[cursor];
        if (it) open(it.runId);
        return;
      }
      if (ch === "o") {
        const it = s.inbox[cursor];
        if (!it) return;
        return browse({ id: it.runId, prUrl: it.prUrl });
      }
      if (ch === "d") return setNotice("dismiss is not wired yet");
      return;
    }

    // Chat: the composer owns the keyboard, apart from transcript scrolling.
    if (key.pageUp) return setScrollBack((n) => n + 5);
    if (key.pageDown) return setScrollBack((n) => Math.max(0, n - 5));
    if (key.tab) {
      const w = s.actions.waiting();
      if (w.length === 0) return setNotice("nobody is waiting on you");
      setNotice(null);
      return setTo((cur) => nextInCycle(w, cur));
    }
    if (key.escape) {
      // Strict order (PRD §6.3): the chip must clear before the input, so a
      // mis-addressed message can be re-aimed without retyping it.
      if (confirm) {
        setConfirm(null);
        return setNotice(null);
      }
      if (notice) return setNotice(null);
      if (to !== null) return setTo(null);
      if (scrollBack) return setScrollBack(0);
      return setInput("");
    }
    if (key.return) return submit();
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
    if (key.ctrl && ch === "u") return setInput("");
    if (ch && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      setInput((v) => v + ch);
    }
  });

  const statusLine = notice ?? statusFor(s.status, s.error);

  // The palette floats over the chat rather than replacing it, so its rows
  // come out of the transcript's budget — otherwise the overlay pushes the
  // status line off a 24-row screen.
  const paletteShown = paletteRows(rows, paletteItems.length);
  const paletteWin = cursorWindow(paletteItems.length, paletteShown, cursor);
  const mainH = view === "palette" ? Math.max(1, rows - 3 - paletteHeight(paletteWin.end - paletteWin.start)) : bodyH;

  const main = (() => {
    if (view === "floor")
      return <Floor forest={s.forest} inboxCount={s.inbox.length} now={s.now} width={mainW} height={bodyH} cursor={cursor} />;
    if (view === "inbox") return <Inbox items={s.inbox} now={s.now} width={mainW} height={bodyH} cursor={cursor} />;
    return (
      <Box flexDirection="column" width={mainW}>
        <ChatHeader run={run} forest={s.forest} now={s.now} width={mainW} />
        <Hair width={mainW} />
        <Transcript
          run={run}
          frames={s.frames}
          forest={s.forest}
          now={s.now}
          width={mainW}
          height={mainH}
          trace={trace}
          scrollBack={scrollBack}
        />
      </Box>
    );
  })();

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={mainW}>
          {main}
          {view !== "palette" && (
            <Prompt
              value={input}
              to={to}
              pendingCount={s.inbox.length}
              width={mainW}
              busy={s.loading}
              maxHelp={screen.helpShown}
            />
          )}
          {view === "palette" && (
            <Box flexDirection="column" width={mainW} alignItems="center" marginBottom={2}>
              <Palette
                items={paletteItems.slice(paletteWin.start, paletteWin.end)}
                query={pq}
                cursor={cursor - paletteWin.start}
                width={mainW}
              />
            </Box>
          )}
          <StatusLine text={statusLine} tone={notice ? "note" : s.status} width={mainW} />
        </Box>
        {railW > 0 && (
          <Box flexDirection="row">
            <Box flexDirection="column" height={rows}>
              <Text color={C.hair}>{Array.from({ length: rows }, () => g.rail).join("\n")}</Text>
            </Box>
            <Roster
              forest={s.forest}
              inboxCount={s.inbox.length}
              now={s.now}
              width={railW - 1}
              height={rows}
              current={s.current}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** One dim line, bottom left: a dropped stream must not look like a freeze. */
function StatusLine({ text, tone, width }: { text: string; tone: string; width: number }) {
  const color = tone === "unauthorized" || tone === "offline" ? C.blocked : tone === "reconnecting" ? C.running : C.muted;
  return (
    <Box width={width}>
      <Text color={color} wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}

function statusFor(status: string, error: string | null): string {
  switch (status) {
    case "connecting":
      return "connecting…";
    case "live":
      return error ?? "live";
    case "reconnecting":
      return error ?? "reconnecting…";
    case "unauthorized":
      return `unauthorized · ${error ?? ""}`.trim();
    default:
      return `offline · ${error ?? "no connection"}`;
  }
}
