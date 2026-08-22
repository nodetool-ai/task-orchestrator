import React from "react";
import { Box, Text } from "ink";
import type { InboxItem } from "../model/inbox.js";
import { C, Hair, Keys, age, padEnd } from "../theme.js";
import { cursorWindow, fit } from "./layout.js";

const kindGlyph: Record<InboxItem["kind"], { g: string; color: string; label: string }> = {
  question: { g: "⚑", color: C.review, label: "asks" },
  review: { g: "◎", color: C.review, label: "review" },
  stuck: { g: "✕", color: C.blocked, label: "stuck" },
  budget: { g: "$", color: C.running, label: "budget" },
};

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
  // glyph+space, id, persona, kind, and the right-aligned age.
  const fixed = 2 + 5 + 13 + 7 + 5;
  const textW = Math.max(8, width - fixed);
  const { start, end } = cursorWindow(items.length, Math.max(1, height - 3), cursor);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>NEEDS YOU</Text>
          <Text color={C.muted}> {items.length}</Text>
        </Text>
        <Keys
          items={[
            ["↑↓", "move"],
            ["↵", "answer / open"],
            ["d", "dismiss"],
            ["esc", "back"],
          ]}
        />
      </Box>
      <Hair width={width} />
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 && <Text color={C.muted}>Nothing waits on you.</Text>}
        {items.slice(start, end).map((it, i) => {
          const k = kindGlyph[it.kind];
          const text = fit(it.text, textW);
          return (
            <Box key={it.id}>
              <Text inverse={start + i === cursor}>
                <Text color={k.color}>{k.g}</Text> <Text color={C.muted}>{padEnd(`#${it.runId}`, 4)}</Text>{" "}
                <Text bold>{padEnd(it.persona, 12)}</Text>
                <Text color={k.color}>{padEnd(k.label, 7)}</Text>
                <Text>{padEnd(text, textW)}</Text>
                <Text color={C.muted}>{age(it.at, now).padStart(4)}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
