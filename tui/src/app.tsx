import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { byId, inbox as seedInbox, runs, transcripts, type InboxItem, type Msg } from "./data.js";
import { C, Hair } from "./theme.js";
import { ChatHeader, Transcript } from "./views/chat.js";
import { Floor, floorRows } from "./views/floor.js";
import { Inbox } from "./views/inbox.js";
import { Palette, filterPalette } from "./views/palette.js";
import { Roster } from "./views/roster.js";
import { Prompt, matchCommands } from "./views/prompt.js";

type View = "chat" | "floor" | "inbox" | "palette";

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 100;
  const rows = stdout.rows ?? 30;

  const [view, setView] = useState<View>("chat");
  const [current, setCurrent] = useState(42);
  const [msgs, setMsgs] = useState<Record<number, Msg[]>>(() => structuredClone(transcripts));
  const [inbox, setInbox] = useState<InboxItem[]>(seedInbox);
  const [input, setInput] = useState("");
  const [to, setTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [rail, setRail] = useState(cols >= 110);
  const [cursor, setCursor] = useState(0);
  const [pq, setPq] = useState("");
  const [tick, setTick] = useState(0);

  // Heartbeat so ages/costs in the mockup feel alive.
  useEffect(() => {
    const t = setInterval(() => {
      for (const r of runs) if (r.status === "running") r.cost += 0.004;
      setTick((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
  }, []);

  const run = byId(current);
  const railW = rail && cols >= 90 ? 38 : 0;
  const mainW = cols - railW - (railW ? 1 : 0);

  const append = (id: number, m: Msg) =>
    setMsgs((s) => ({ ...s, [id]: [...(s[id] ?? []), m] }));

  // Fake the agent side so the conversation has rhythm.
  const fakeReply = (id: number, text: string) => {
    setBusy(true);
    const r = byId(id);
    const t1 = setTimeout(() => append(id, { kind: "tool", run: id, text: "thinking", detail: ["reading context"] }), 500);
    const t2 = setTimeout(() => {
      append(id, {
        kind: "agent",
        run: id,
        text:
          r.persona === "concierge"
            ? `On it. I will route "${text.slice(0, 40)}" — if it needs code I spawn an implementor and you will hear from me when a PR exists.`
            : `Noted: "${text.slice(0, 40)}". Continuing.`,
      });
      setBusy(false);
    }, 1400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  };

  const answerQuestion = (runId: number, answer: string) => {
    const r = byId(runId);
    r.status = "running";
    r.question = undefined;
    setInbox((s) => s.filter((i) => !(i.kind === "question" && i.run === runId)));
    setMsgs((s) => {
      const next = { ...s };
      for (const k of Object.keys(next)) {
        next[+k] = next[+k].map((m) => (m.kind === "question" && m.run === runId && !m.answered ? { ...m, answered: answer } : m));
      }
      return next;
    });
    if (r.parentId !== null) {
      const top = (() => {
        let p = r;
        while (p.parentId !== null) p = byId(p.parentId);
        return p.id;
      })();
      append(top, { kind: "event", run: top, text: `you answered #${runId} · it resumed`, tone: "ok" });
    }
    setTimeout(() => append(runId, { kind: "agent", run: runId, text: `Thanks — going with "${answer}".` }), 700);
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    // Slash commands.
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "/floor":
          setCursor(0);
          setView("floor");
          return;
        case "/inbox":
          setCursor(0);
          setView("inbox");
          return;
        case "/open": {
          const id = Number(arg.replace("#", ""));
          if (runs.some((r) => r.id === id)) setCurrent(id);
          return;
        }
        case "/new": {
          const [persona, ...goal] = rest;
          const id = Math.max(...runs.map((r) => r.id)) + 1;
          runs.unshift({ id, parentId: null, persona: persona || "concierge", title: goal.join(" ") || "(no goal)", status: "preparing", startedMin: 0, cost: 0 });
          setMsgs((s) => ({ ...s, [id]: [{ kind: "user", text: goal.join(" ") }] }));
          setCurrent(id);
          setTimeout(() => {
            byId(id).status = "running";
            fakeReply(id, goal.join(" "));
          }, 900);
          return;
        }
        case "/spawn": {
          append(current, { kind: "user", text });
          const id = Math.max(...runs.map((r) => r.id)) + 1;
          runs.push({ id, parentId: current, persona: rest[0] || "implementor", title: rest.slice(1).join(" ") || "(no goal)", status: "preparing", startedMin: 0, cost: 0 });
          setMsgs((s) => ({ ...s, [id]: [] }));
          setTimeout(() => {
            append(current, { kind: "spawn", run: current, children: [id] });
            setTimeout(() => {
              byId(id).status = "running";
              setTick((n) => n + 1);
            }, 1500);
          }, 500);
          return;
        }
        case "/cancel":
          run.status = "failed";
          append(current, { kind: "event", run: current, text: "cancelled by you", tone: "warn" });
          return;
        case "/quit":
          exit();
          return;
        default:
          append(current, { kind: "event", run: current, text: `${cmd}: mockup only`, tone: "warn" });
          return;
      }
    }
    if (to !== null) {
      const target = to;
      setTo(null);
      append(current, { kind: "user", text, to: target });
      answerQuestion(target, text);
      return;
    }
    append(current, { kind: "user", text });
    fakeReply(current, text);
  };

  useInput((ch, key) => {
    // Global chords.
    if (key.ctrl && ch === "c") return exit();
    if (key.ctrl && ch === "k") {
      setPq("");
      setCursor(0);
      setView(view === "palette" ? "chat" : "palette");
      return;
    }
    if (key.ctrl && ch === "f") {
      setCursor(0);
      setView(view === "floor" ? "chat" : "floor");
      return;
    }
    if (key.ctrl && ch === "n") {
      setCursor(0);
      setView(view === "inbox" ? "chat" : "inbox");
      return;
    }
    if (key.ctrl && ch === "b") return setRail((r) => !r);

    if (view === "palette") {
      const items = filterPalette(pq);
      if (key.escape) return setView("chat");
      if (key.return) {
        const it = items[cursor];
        if (it?.kind === "run") setCurrent(Number(it.id.slice(1)));
        setView("chat");
        return;
      }
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(items.length - 1, c + 1));
      if (key.backspace || key.delete) return setPq((q) => q.slice(0, -1));
      if (ch && !key.ctrl && !key.meta) setPq((q) => q + ch);
      return;
    }
    if (view === "floor") {
      const rowsF = floorRows();
      if (key.escape) return setView("chat");
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(rowsF.length - 1, c + 1));
      if (key.return) {
        setCurrent(rowsF[cursor].run.id);
        setView("chat");
        return;
      }
      if (ch === "c") {
        rowsF[cursor].run.status = "failed";
        setTick((n) => n + 1);
        return;
      }
      if (ch === "n") {
        setView("chat");
        setInput("/new concierge ");
        return;
      }
      return;
    }
    if (view === "inbox") {
      if (key.escape) return setView("chat");
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(inbox.length - 1, c + 1));
      if (ch === "d") return setInbox((s) => s.filter((_, i) => i !== cursor));
      if (key.return) {
        const it = inbox[cursor];
        if (!it) return;
        if (it.kind === "question") {
          // Answer from wherever you are; the chat shows the question.
          setTo(it.run);
        } else {
          setCurrent(it.run);
        }
        setView("chat");
        return;
      }
      return;
    }

    // Chat view: the composer owns the keyboard.
    if (key.escape) {
      if (to !== null) return setTo(null);
      if (input) return setInput("");
      return;
    }
    if (key.tab) {
      const qs = inbox.filter((i) => i.kind === "question");
      if (qs.length === 0) return;
      const idx = to === null ? 0 : (qs.findIndex((q) => q.run === to) + 1) % qs.length;
      setTo(qs[idx].run);
      return;
    }
    if (key.return) return submit();
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    if (key.ctrl && ch === "u") return setInput("");
    if (ch && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      setInput((s) => s + ch);
    }
  });

  const header = useMemo(() => <ChatHeader run={run} width={mainW} />, [run, mainW, tick]);
  const promptLines = 3 + matchCommands(input).length + (inbox.some((i) => i.kind === "question") && to === null ? 1 : 0);
  const bodyH = rows - 2 - promptLines; // header + hairline

  const main = (() => {
    if (view === "floor") return <Floor width={mainW} height={bodyH} cursor={cursor} />;
    if (view === "inbox") return <Inbox items={inbox} width={mainW} height={bodyH} cursor={cursor} />;
    return (
      <Box flexDirection="column" width={mainW}>
        {header}
        <Hair width={mainW} />
        <Transcript run={run} msgs={msgs[current] ?? []} width={mainW} height={bodyH} />
      </Box>
    );
  })();

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={mainW}>
          {main}
          {view !== "palette" && <Prompt value={input} to={to} pending={inbox} width={mainW} busy={busy} />}
          {view === "palette" && (
            <Box flexDirection="column" width={mainW} alignItems="center" marginBottom={2}>
              <Palette query={pq} cursor={cursor} width={mainW} />
            </Box>
          )}
        </Box>
        {railW > 0 && (
          <Box flexDirection="row">
            <Box flexDirection="column" height={rows}>
              <Text color={C.hair}>{"│\n".repeat(rows)}</Text>
            </Box>
            <Roster width={railW - 1} height={rows} current={current} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
