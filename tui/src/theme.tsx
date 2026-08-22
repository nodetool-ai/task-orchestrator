import React from "react";
import { Box, Text } from "ink";
import type { TuiStatus } from "./model/status.js";

// One implementation of the formatting helpers, in the model layer, so a row
// and a header can never disagree about what "12m" or "$1.20" means.
export { age, ageMinutes, usd } from "./model/time.js";

// Six-colour vocabulary, same discipline as the web app: colour means state.
export const C = {
  fg: "white",
  muted: "gray",
  hair: "#3a3a3f",
  running: "#f59f0a",
  review: "#a662ea",
  blocked: "#e25050",
  done: "#2eb877",
  queued: "#95959d",
  you: "#6ea8fe",
};

export const glyph: Record<TuiStatus, { g: string; color: string }> = {
  running: { g: "●", color: C.running },
  preparing: { g: "◐", color: C.running },
  queued: { g: "○", color: C.queued },
  parked: { g: "⚑", color: C.review },
  idle: { g: "◌", color: C.queued },
  done: { g: "✓", color: C.done },
  failed: { g: "✕", color: C.blocked },
};

export function StatusGlyph({ s }: { s: TuiStatus }) {
  const { g, color } = glyph[s];
  return <Text color={color}>{g}</Text>;
}

/** The colour a status word is printed in — the glyph's colour, reused. */
export function statusColor(s: TuiStatus): string {
  return glyph[s].color;
}

export function Hair({ width }: { width: number }) {
  return <Text color={C.hair}>{"─".repeat(Math.max(0, width))}</Text>;
}

export function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color={C.fg}>{k}</Text>
      <Text color={C.muted}> {label}</Text>
    </Text>
  );
}

export function Keys({ items }: { items: [string, string][] }) {
  return (
    <Box gap={2}>
      {items.map(([k, l]) => (
        <Key key={k} k={k} label={l} />
      ))}
    </Box>
  );
}

export function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
