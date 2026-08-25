import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { OrchClient } from "./api/client.js";
import { confirmLine, liveKids, nextInCycle, openUrlFor, parseBudget, resolvePersona, spawnMessage } from "./cli/commands.js";
import { openInBrowser } from "./cli/open.js";
import { floorGroups } from "./model/forest.js";
import { isLive } from "./model/status.js";
import * as ed from "./model/composer.js";
import type { Composer } from "./model/composer.js";
import { applyModelCompletion, matchModels } from "./model/models.js";
import { filterPalette } from "./model/palette.js";
import { useOrch } from "./store.js";
import { C, GlyphProvider, Hair, useGlyphs } from "./theme.js";
import { ChatHeader, Transcript } from "./views/chat.js";
import { Floor } from "./views/floor.js";
import { Inbox } from "./views/inbox.js";
import { Palette } from "./views/palette.js";
import { Roster } from "./views/roster.js";
import { Prompt, matchCommands } from "./views/prompt.js";
import { MotionProvider, motionEnabled } from "./views/motion.js";
import { LiveLine } from "./views/spinner.js";
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
  /** Overrides the environment's answer. The mock turns it on so the live
   *  line can be looked at without a server. */
  motion?: boolean;
}

export function App({ client, initial, baseUrl, openUrl, ascii, motion }: AppProps) {
  const moves = motion ?? motionEnabled(process.env, ascii === true, process.stdout.isTTY === true);
  return (
    <GlyphProvider ascii={ascii === true}>
      <MotionProvider enabled={moves}>
        <Cockpit client={client} initial={initial} baseUrl={baseUrl} openUrl={openUrl} />
      </MotionProvider>
    </GlyphProvider>
  );
}

// Split from App so every view below — and the cockpit's own key handling —
// reads the glyph table out of the context rather than off a prop.
function Cockpit({ client, initial, baseUrl, openUrl }: Omit<AppProps, "ascii" | "motion">) {
  const { exit } = useApp();
  const g = useGlyphs();
  const base = baseUrl ?? process.env.ORCH_URL ?? DEFAULT_URL;
  const launch = openUrl ?? openInBrowser;
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 100;
  const rows = stdout.rows ?? 30;

  const s = useOrch(client, initial == null ? {} : { current: initial });

  const [view, setView] = useState<View>("chat");
  // The whole composer — line, cursor and recall history — is one value with
  // one setter (model/composer.ts), so a keystroke updates all three or none.
  const [comp, setComp] = useState<Composer>(ed.emptyComposer);
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
  // The highlighted `/model` suggestion. Reset by every input change, so it
  // can never point past a list that just shrank.
  const [compIx, setCompIx] = useState(0);

  const run = s.current === null ? null : (s.forest.byId(s.current) ?? null);

  // Every width and height in one arithmetic (views/layout.ts), because the
  // transcript is sized from what the prompt leaves over and an under-count
  // here over-draws the screen. `help` and `pending` are what <Prompt> is
  // about to paint above the composer.
  const pending = s.inbox.length > 0 && to === null;
  // The live line only exists while the open run is working, so it is part of
  // the same arithmetic as the command help: a row the transcript gives up.
  const live = view === "chat" && run !== null && isLive(run.status);
  const comps = useMemo(() => matchModels(comp.line.text, s.models), [comp.line.text, s.models]);
  const screen = screenLayout(cols, rows, {
    rail,
    help: comps.length > 0 ? comps.length : matchCommands(comp.line.text).length,
    pending,
    spinner: live,
  });
  const { railW, mainW, bodyH } = screen;
  // What actually fits above the composer. Completion stays WYSIWYG: on a
  // short terminal `tab` can only accept a row the operator was shown.
  const shownComps = comps.slice(0, screen.helpShown);

  const floorRows = useMemo(() => {
    const { live, rest } = floorGroups(s.forest, g);
    return [...live, ...rest];
  }, [s.forest, g]);
  const paletteItems = useMemo(() => filterPalette(s.palette, pq), [s.palette, pq]);

  // Warm, so `/new implementor …` can be validated the moment it is typed and
  // `/model ` completes on the first space.
  useEffect(() => {
    s.actions.ensurePersonas();
    s.actions.ensureModels();
  }, [s.actions]);

  const open = (id: number) => {
    if (id === s.current) return setView("chat");
    s.actions.select(id);
    setScrollBack(0);
    setView("chat");
  };

  // One door into the composer, so a highlight never survives the keystroke
  // that changed what it points at.
  const edit = (e: ed.Edit) => {
    setCompIx(0);
    setComp((c) => e(c));
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
    const text = comp.line.text.trim();
    setCompIx(0);
    setComp((c) => ed.commit(c, text));
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
        if (!id) return setNotice("/model <id> — e.g. /model claude-sonnet-4-6");
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
        edit(ed.insertText("/new "));
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
    // While `/model` suggests, the arrows walk the suggestions; they had no
    // job in the composer before (scrolling is pgup/pgdn). Otherwise ↓/↑ walk
    // the recall history, newest first.
    if (shownComps.length > 0 && key.upArrow) return setCompIx((i) => Math.max(0, i - 1));
    if (shownComps.length > 0 && key.downArrow) return setCompIx((i) => Math.min(shownComps.length - 1, i + 1));
    if (key.tab) {
      // Mid-command the suggestions own `tab`: a leading slash routes to the
      // command switch, never to an agent, so there is no addressing to lose.
      if (comp.line.text.startsWith("/") && shownComps.length > 0) {
        const pick = shownComps[Math.min(compIx, shownComps.length - 1)];
        return edit(ed.replaced(applyModelCompletion(comp.line.text, pick.value)));
      }
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
      return edit(ed.clear);
    }
    if (key.return) return submit();
    // Line editing, readline-shaped (model/composer.ts): a cursor you can
    // move, word motions under ⌥, positional erase. The composer used to be
    // append-only, so a typo at the top of a long goal cost the whole line.
    if (key.home || (key.ctrl && ch === "a")) return edit(ed.cursorHome);
    if (key.end || (key.ctrl && ch === "e")) return edit(ed.cursorEnd);
    if (key.leftArrow) return edit(key.meta ? ed.cursorWordBack : ed.cursorLeft);
    if (key.rightArrow) return edit(key.meta ? ed.cursorWordForward : ed.cursorRight);
    if (key.upArrow) return edit((c) => ed.recallPrev(c));
    if (key.downArrow) return edit((c) => ed.recallNext(c));
    if (key.backspace) return edit(key.meta || (key.ctrl && ch === "w") ? ed.killWord : ed.erase);
    // Forward delete is its own key now that there is a cursor to delete at.
    if (key.delete) return edit(ed.eraseForward);
    if (key.ctrl && ch === "u") return edit(ed.clear);
    if (ch && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      edit(ed.insertText(ch));
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
          {live && run !== null && <LiveLine run={run} forest={s.forest} width={mainW} now={s.now} />}
          {view !== "palette" && (
            <Prompt
              value={comp.line.text}
              cur={comp.line.cur}
              to={to}
              pendingCount={s.inbox.length}
              width={mainW}
              busy={s.loading}
              maxHelp={screen.helpShown}
              completions={shownComps}
              completionIndex={Math.min(compIx, Math.max(0, comps.length - 1))}
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
