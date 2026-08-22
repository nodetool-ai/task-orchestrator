import React from "react";
import { Box, Text } from "ink";
import type { InboxItem } from "../model/inbox.js";
import { C, Hair, Keys, age, useGlyphs } from "../theme.js";
import type { Glyphs } from "../model/glyphs.js";
import { cursorWindow, layoutInboxHead, layoutInboxRow } from "./layout.js";

function kindGlyphs(g: Glyphs): Record<InboxItem["kind"], { g: string; color: string; label: string }> {
  return {
    question: { g: g.flag, color: C.review, label: "asks" },
    review: { g: g.review, color: C.review, label: "review" },
    stuck: { g: g.fail, color: C.blocked, label: "stuck" },
    // `$` is already ASCII, so it is the same mark in both modes.
    budget: { g: "$", color: C.running, label: "budget" },
  };
}

// Everything that is waiting on a human, newest first. Enter on a question
// drops you into the chat with the asking agent addressed.
export function Inbox({
  items,
  now,
  width,
  height,
  cursor,
}: {
  items: InboxItem[];
  now: number;
  width: number;
  height: number;
  cursor: number;
}) {
  const g = useGlyphs();
  const kindGlyph = kindGlyphs(g);
  const { start, end } = cursorWindow(items.length, Math.max(1, height - 3), cursor);
  const head = layoutInboxHead({
    count: items.length,
    width,
    glyphs: g,
    keys: [
      [g.move, "move"],
      [g.enter, "answer / open"],
      ["o", "open"],
      ["d", "dismiss"],
      ["esc", "back"],
    ],
  });
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{head.parts[0]}</Text>
          <Text color={C.muted}>{head.parts[1]}</Text>
        </Text>
        <Keys items={head.keys} />
      </Box>
      <Hair width={width} />
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 && <Text color={C.muted}>Nothing waits on you.</Text>}
        {items.slice(start, end).map((it, i) => {
          const k = kindGlyph[it.kind];
          const c = layoutInboxRow({
            mark: k.g,
            runId: it.runId,
            persona: it.persona,
            label: k.label,
            text: it.text,
            age: age(it.at, now),
            width,
            glyphs: g,
          });
          return (
            <Box key={it.id}>
              <Text inverse={start + i === cursor}>
                <Text color={k.color}>{c.mark}</Text> <Text color={C.muted}>{c.id}</Text>
                <Text bold color={C.fg}>{c.persona}</Text>
                <Text color={k.color}>{c.label}</Text>
                <Text color={C.fg}>{c.text}</Text>
                <Text color={C.muted}>{c.age}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
