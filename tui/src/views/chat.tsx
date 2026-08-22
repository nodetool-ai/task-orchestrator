import React from "react";
import { Box, Text } from "ink";
import { byId, childrenOf, type Msg, type Run } from "../data.js";
import { C, StatusGlyph, age, usd } from "../theme.js";
import { flattenFrom, RunRow } from "./tree.js";

// One transcript line-group. Mirrors the Claude Code rhythm: your turns are
// `>` lines, agent prose is plain, tool calls are one dim `⎿` line, spawned
// children render as a live mini-tree inline, and questions are loud.
function Message({ m, width, self }: { m: Msg; width: number; self: Run }) {
  switch (m.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={C.you}>{"> "}</Text>
          {m.to !== undefined && <Text color={C.review}>@#{m.to} </Text>}
          <Text>{m.text}</Text>
        </Box>
      );
    case "agent": {
      const r = byId(m.run);
      const foreign = r.id !== self.id;
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <StatusGlyph s={r.status} />
            <Text bold> {r.persona}</Text>
            {foreign && <Text color={C.muted}> #{r.id}</Text>}
          </Box>
          <Box paddingLeft={2} width={width}>
            <Text wrap="wrap">{m.text}</Text>
          </Box>
        </Box>
      );
    }
    case "tool":
      return (
        <Box paddingLeft={2}>
          <Text color={C.muted}>
            ⎿ {m.text}
            {m.detail ? ` · ${m.detail.join(" · ")}` : ""}
          </Text>
        </Box>
      );
    case "spawn": {
      // Live: children rows reflect current status, not the moment of spawn.
      const kids = m.children.map(byId);
      const rows = flattenFrom(kids);
      return (
        <Box paddingLeft={2} flexDirection="column">
          <Text color={C.muted}>⎿ spawned {kids.length === 1 ? `${kids[0].persona} #${kids[0].id}` : `${kids.length} agents`}</Text>
          <Box paddingLeft={2} flexDirection="column">
            {rows.map((row) => (
              <RunRow key={row.run.id} row={row} width={width - 6} />
            ))}
          </Box>
        </Box>
      );
    }
    case "event": {
      const color = m.tone === "ok" ? C.done : m.tone === "warn" ? C.blocked : C.muted;
      return (
        <Box paddingLeft={2}>
          <Text color={color}>· {m.text}</Text>
        </Box>
      );
    }
    case "question": {
      const r = byId(m.run);
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={C.review}>⚑ </Text>
            <Text bold>{r.persona}</Text>
            <Text color={C.muted}> #{r.id} asks</Text>
          </Box>
          <Box paddingLeft={2} width={width}>
            <Text wrap="wrap" color={m.answered ? C.muted : C.fg}>
              {m.text}
            </Text>
          </Box>
          {m.answered ? (
            <Box paddingLeft={2}>
              <Text color={C.muted}>
                ↳ you: <Text color={C.fg}>{m.answered}</Text>
              </Text>
            </Box>
          ) : (
            <Box paddingLeft={2}>
              <Text color={C.muted}>
                <Text color={C.fg}>tab</Text> to answer · <Text color={C.fg}>/open #{r.id}</Text> to see its work
              </Text>
            </Box>
          )}
        </Box>
      );
    }
  }
}

export function ChatHeader({ run, width }: { run: Run; width: number }) {
  const kids = childrenOf(run.id);
  const parent = run.parentId !== null ? byId(run.parentId) : null;
  return (
    <Box width={width} justifyContent="space-between">
      <Box>
        {parent && (
          <Text color={C.muted}>
            {parent.persona} #{parent.id} ›{" "}
          </Text>
        )}
        <StatusGlyph s={run.status} />
        <Text bold> {run.persona}</Text>
        <Text color={C.muted}> #{run.id} · </Text>
        <Text>{run.title}</Text>
      </Box>
      <Text color={C.muted}>
        {run.status === "running" ? `${age(run.startedMin)} · ` : ""}
        {kids.length > 0 ? `${kids.length} agents · ` : ""}
        {usd(run.cost)}
      </Text>
    </Box>
  );
}

export function Transcript({ run, msgs, width, height }: { run: Run; msgs: Msg[]; width: number; height: number }) {
  // Cheap "scroll to bottom": render only the last N messages that plausibly fit.
  const budget = Math.max(3, Math.floor(height / 2));
  const tail = msgs.slice(-budget);
  return (
    <Box flexDirection="column" height={height} overflow="hidden" justifyContent="flex-end">
      {tail.map((m, i) => (
        <Message key={i} m={m} width={width} self={run} />
      ))}
    </Box>
  );
}
