import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { OrchClient } from "./api/client.js";
import { floorGroups } from "./model/forest.js";
import { filterPalette } from "./model/palette.js";
import { useOrch } from "./store.js";
import { C, Hair } from "./theme.js";
import { ChatHeader, Transcript } from "./views/chat.js";
import { Floor } from "./views/floor.js";
import { Inbox } from "./views/inbox.js";
import { Palette } from "./views/palette.js";
import { Roster } from "./views/roster.js";
import { Prompt, matchCommands } from "./views/prompt.js";

type View = "chat" | "floor" | "inbox" | "palette";

// M1 is read-only (TASKS.md): navigation only, nothing that writes to the
// server. Everything else answers with "arrives in M2" rather than pretending.
const M2_COMMANDS = new Set(["/new", "/spawn", "/cancel", "/say", "/model", "/budget"]);

export function App({ client }: { client: OrchClient }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 100;
  const rows = stdout.rows ?? 30;

  const s = useOrch(client);

  const [view, setView] = useState<View>("chat");
  const [input, setInput] = useState("");
  const [pq, setPq] = useState("");
  const [cursor, setCursor] = useState(0);
  const [trace, setTrace] = useState(false);
  const [scrollBack, setScrollBack] = useState(0);
  const [rail, setRail] = useState(cols >= 110);
  const [notice, setNotice] = useState<string | null>(null);

  const run = s.current === null ? null : (s.forest.byId(s.current) ?? null);
  const railW = rail && cols >= 110 ? 38 : 0;
  const mainW = cols - railW - (railW ? 1 : 0);

  const floorRows = useMemo(() => {
    const { live, rest } = floorGroups(s.forest);
    return [...live, ...rest];
  }, [s.forest]);
  const paletteItems = useMemo(() => filterPalette(s.palette, pq), [s.palette, pq]);

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

  const submit = () => {
    const text = input.trim();
    setInput("");
    if (!text) return;
    if (!text.startsWith("/")) {
      setNotice("read-only cockpit · sending arrives in M2");
      return;
    }
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "/floor":
        return go(view === "floor" ? "chat" : "floor");
      case "/inbox":
        return go(view === "inbox" ? "chat" : "inbox");
      case "/open": {
        const id = Number(arg.replace("#", ""));
        if (Number.isFinite(id) && s.forest.byId(id)) return open(id);
        return setNotice(`no run #${arg.replace("#", "")}`);
      }
      case "/trace":
        setTrace((t) => !t);
        return setNotice(`tool trace ${trace ? "off" : "on"}`);
      case "/quit":
        return exit();
      default:
        return setNotice(M2_COMMANDS.has(cmd) ? `${cmd} arrives in M2` : `${cmd}: unknown command`);
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
      if (key.escape) return setView("chat");
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(floorRows.length - 1, c + 1));
      if (key.return) {
        const row = floorRows[cursor];
        if (row) open(row.run.id);
        return;
      }
      if (ch === "c" || ch === "n") return setNotice(`${ch} arrives in M2`);
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
      if (ch === "d") return setNotice("dismiss arrives in M2");
      return;
    }

    // Chat: the composer owns the keyboard, apart from transcript scrolling.
    if (key.pageUp) return setScrollBack((n) => n + 5);
    if (key.pageDown) return setScrollBack((n) => Math.max(0, n - 5));
    if (key.escape) {
      setNotice(null);
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

  const promptLines = 3 + matchCommands(input).length;
  const statusLine = notice ?? statusFor(s.status, s.error);
  const bodyH = Math.max(3, rows - 3 - promptLines); // header + hair + status

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
          height={bodyH}
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
              to={null}
              pendingCount={s.inbox.length}
              width={mainW}
              busy={s.loading}
              readOnly
            />
          )}
          {view === "palette" && (
            <Box flexDirection="column" width={mainW} alignItems="center" marginBottom={2}>
              <Palette items={paletteItems} query={pq} cursor={cursor} width={mainW} />
            </Box>
          )}
          <StatusLine text={statusLine} tone={notice ? "note" : s.status} width={mainW} />
        </Box>
        {railW > 0 && (
          <Box flexDirection="row">
            <Box flexDirection="column" height={rows}>
              <Text color={C.hair}>{"│\n".repeat(rows)}</Text>
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
