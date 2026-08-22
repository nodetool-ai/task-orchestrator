import React from "react";
import { Box, Text } from "ink";
import { byId, type InboxItem } from "../data.js";
import { C, Keys, Hair, age, padEnd } from "../theme.js";

const kindGlyph: Record<InboxItem["kind"], { g: string; color: string; label: string }> = {
  question: { g: "⚑", color: C.review, label: "asks" },
  review: { g: "◎", color: C.review, label: "review" },
  stuck: { g: "✕", color: C.blocked, label: "stuck" },
  budget: { g: "$", color: C.running, label: "budget" },
};

// Everything that is waiting on a human, newest first. Enter on a question
// drops you into the chat with the asking agent addressed.
export function Inbox({ items, width, height, cursor }: { items: InboxItem[]; width: number; height: number; cursor: number }) {
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
        {items.map((it, i) => {
          const k = kindGlyph[it.kind];
          const r = byId(it.run);
          return (
            <Box key={it.id}>
              <Text inverse={i === cursor}>
                <Text color={k.color}>{k.g}</Text> <Text color={C.muted}>{padEnd(`#${r.id}`, 4)}</Text>{" "}
                <Text bold>{padEnd(r.persona, 12)}</Text>
                <Text color={k.color}>{padEnd(k.label, 7)}</Text>
                <Text>{padEnd(it.text, Math.max(10, width - 36))}</Text>
                <Text color={C.muted}>{age(it.ageMin).padStart(4)}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
