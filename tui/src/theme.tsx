import React from "react";
import { Box, Text } from "ink";
import type { Status } from "./data.js";

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

export const glyph: Record<Status, { g: string; color: string }> = {
  running: { g: "●", color: C.running },
  preparing: { g: "◐", color: C.running },
  queued: { g: "○", color: C.queued },
  parked: { g: "⚑", color: C.review },
  idle: { g: "◌", color: C.queued },
  done: { g: "✓", color: C.done },
  failed: { g: "✕", color: C.blocked },
};

export function StatusGlyph({ s }: { s: Status }) {
  const { g, color } = glyph[s];
  return <Text color={color}>{g}</Text>;
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

export function age(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
