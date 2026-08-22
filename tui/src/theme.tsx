import React, { createContext, useContext } from "react";
import { Box, Text } from "ink";
import { glyphs, UNICODE, type Glyphs } from "./model/glyphs.js";
import { C, hueFor } from "./model/colors.js";
import type { TuiStatus } from "./model/status.js";

// One implementation of the formatting helpers, in the model layer, so a row
// and a header can never disagree about what "12m" or "$1.20" means.
export { age, ageMinutes, usd } from "./model/time.js";
export { glyphs, type Glyphs } from "./model/glyphs.js";

// Six-colour vocabulary, same discipline as the web app: colour means state.
// The table itself (and its 16-colour fallback) lives in model/colors.ts, so
// the pure modules can read it without importing Ink.
export { C, applyColorMode, colorMode, orchColors, type ColorMode, type Palette } from "./model/colors.js";

// A context rather than a prop threaded through every view: the glyph table is
// process-wide and never changes after argv is parsed, so passing it by hand
// would be twenty signatures carrying one constant. The pure modules that
// cannot see a context (views/layout.ts, cli/format.ts) take it as an
// argument instead.
const GlyphContext = createContext<Glyphs>(UNICODE);

export function GlyphProvider({ ascii, children }: { ascii: boolean; children: React.ReactNode }) {
  return <GlyphContext.Provider value={glyphs(ascii)}>{children}</GlyphContext.Provider>;
}

export function useGlyphs(): Glyphs {
  return useContext(GlyphContext);
}

export function StatusGlyph({ s }: { s: TuiStatus }) {
  const g = useGlyphs();
  return <Text color={statusColor(s)}>{g.status[s]}</Text>;
}

/** The colour a status word — and its glyph — is printed in. One accessor, so
 *  the views never see which palette is live. */
export function statusColor(s: TuiStatus): string {
  return hueFor(s, C);
}

export function Hair({ width }: { width: number }) {
  const g = useGlyphs();
  return <Text color={C.hair}>{g.rule.repeat(Math.max(0, width))}</Text>;
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
