import React, { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Svg, { Polyline } from "react-native-svg";

import { Icon, type IconName } from "./Icon";
import { StateIcon } from "./StateIcon";
import { elapsed as fmtElapsed, elapsedHms } from "@/lib/format";
import { useTheme, mono, stateColor, toAlpha, type RunState } from "@/theme";

export { Press } from "./Press";

// ---- Text helpers ---------------------------------------------------------

export function Txt(props: Text["props"]) {
  const { c } = useTheme();
  return <Text {...props} style={[{ color: c.fg }, props.style]} />;
}

export function Mono(props: Text["props"]) {
  const { c } = useTheme();
  return (
    <Text
      {...props}
      style={[{ color: c.muted, fontFamily: mono, fontVariant: ["tabular-nums"] }, props.style]}
    />
  );
}

// ---- StatePill ------------------------------------------------------------

export function StatePill({
  state,
  label,
  size = "sm",
  live = false,
}: {
  state: RunState;
  label?: string;
  size?: "xs" | "sm";
  live?: boolean;
}) {
  const { c } = useTheme();
  const lbl = label ?? STATE_LABEL[state];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: size === "xs" ? 6 : 8,
        paddingVertical: size === "xs" ? 1 : 2,
        borderRadius: 6,
        backgroundColor: "hsla(240, 4%, 14%, 0.6)",
        borderWidth: 1,
        borderColor: c.hairline,
      }}
    >
      <StateIcon state={state} size={size === "xs" ? 11 : 12} spin={live && state === "in_progress"} />
      <Text style={{ color: c.fg, fontSize: size === "xs" ? 11 : 12, fontWeight: "500" }}>{lbl}</Text>
    </View>
  );
}

export const STATE_LABEL: Record<RunState, string> = {
  todo: "Todo",
  in_progress: "Running",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

// ---- Badge ----------------------------------------------------------------

export function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "default" | "muted" }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        backgroundColor: tone === "default" ? "hsla(240, 4%, 14%, 0.8)" : "transparent",
        borderWidth: 1,
        borderColor: c.hairline,
      }}
    >
      <Text style={{ color: c.muted, fontSize: 11, fontWeight: "500" }}>{children}</Text>
    </View>
  );
}

// ---- ProgressBar ----------------------------------------------------------

export function ProgressBar({
  value,
  max = 1,
  color,
  height = 3,
}: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
}) {
  const { c } = useTheme();
  const pct = Math.max(0, Math.min(1, max ? value / max : 0));
  return (
    <View style={{ width: "100%", height, backgroundColor: "hsla(240, 4%, 20%, 0.6)", borderRadius: 2, overflow: "hidden" }}>
      <View style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: color || c.fg, borderRadius: 2 }} />
    </View>
  );
}

// ---- Sparkline ------------------------------------------------------------

export function Sparkline({
  values,
  width = 80,
  height = 18,
  color,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const { c } = useTheme();
  if (!values || values.length === 0) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <Svg width={width} height={height}>
      <Polyline
        points={pts}
        fill="none"
        stroke={color || c.fg}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      />
    </Svg>
  );
}

// ---- PersonaChip (role/model graphite glyph) ------------------------------

const ROLE_ICON: Record<string, IconName> = {
  planner: "plans",
  designer: "edit",
  implementor: "code",
  reviewer: "check",
  qa: "check",
};

export function PersonaChip({
  id,
  label,
  showModel,
  model,
  strong,
}: {
  id?: string | null;
  label?: string | null;
  showModel?: boolean;
  model?: string | null;
  strong?: boolean;
}) {
  const { c } = useTheme();
  const name = label || id || model || "agent";
  const icon: IconName = (id && ROLE_ICON[id]) || "user";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
      <View
        style={{
          width: 17,
          height: 17,
          borderRadius: 5,
          backgroundColor: c.raised,
          borderWidth: 1,
          borderColor: c.hairline,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={10.5} color={c.muted} />
      </View>
      <Text numberOfLines={1} style={{ fontSize: 11.5, fontWeight: "500", color: strong ? c.fg : c.muted }}>
        {cap(name)}
      </Text>
      {showModel && model ? (
        <Mono style={{ fontSize: 10, color: c.muted2 }} numberOfLines={1}>
          {model}
        </Mono>
      ) : null}
    </View>
  );
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ---- LiveDot (pulsing ring) ----------------------------------------------

export function LiveDot({ size = 10, color }: { size?: number; color?: string }) {
  const { c } = useTheme();
  const col = color || c.sProgress;
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  const dot = size * 0.5;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: col,
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.15] }) }],
        }}
      />
      <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: col }} />
    </View>
  );
}

// ---- Tile (labelled metadata block) --------------------------------------

export function Tile({
  label,
  children,
  style,
}: {
  label: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  return (
    <View
      style={[
        { backgroundColor: c.surface, borderWidth: 1, borderColor: c.hairline, borderRadius: 12, padding: 12 },
        style,
      ]}
    >
      <Text style={[styles.tileLabel, { color: c.muted2 }]}>{label.toUpperCase()}</Text>
      {children}
    </View>
  );
}

export function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <View style={style}>
      <Text style={[styles.fieldLabel, { color: c.muted }]}>{label.toUpperCase()}</Text>
      {children}
    </View>
  );
}

// ---- SectionHead ----------------------------------------------------------

export function SectionHead({
  glyph,
  title,
  count,
  right,
}: {
  glyph?: React.ReactNode;
  title: string;
  count?: number;
  right?: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingBottom: 8 }}>
      {glyph}
      <Text style={{ fontSize: 13, fontWeight: "600", color: c.fg, letterSpacing: -0.1 }}>{title}</Text>
      {count != null && (
        <Mono style={{ fontSize: 11, color: c.muted2 }}>{String(count).padStart(2, "0")}</Mono>
      )}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

// ---- EmptyNote ------------------------------------------------------------

export function EmptyNote({ children }: { children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        marginHorizontal: 16,
        marginBottom: 8,
        padding: 16,
        borderWidth: 1,
        borderColor: c.hairline,
        borderStyle: "dashed",
        borderRadius: 14,
      }}
    >
      <Text style={{ color: c.muted2, fontSize: 12, fontWeight: "500", textAlign: "center" }}>{children}</Text>
    </View>
  );
}

// ---- Elapsed (ticking timer) ---------------------------------------------

export function Elapsed({
  startMs,
  paused,
  format = "long",
  style,
}: {
  startMs: number;
  paused?: boolean;
  format?: "long" | "hms";
  style?: StyleProp<TextStyle>;
}) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused]);
  return <Text style={style}>{format === "hms" ? elapsedHms(startMs, now) : fmtElapsed(startMs, now)}</Text>;
}

// ---- CyclingText ----------------------------------------------------------

export function CyclingText({
  items,
  intervalMs = 3000,
  style,
}: {
  items: string[];
  intervalMs?: number;
  style?: StyleProp<TextStyle>;
}) {
  const [idx, setIdx] = React.useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    if (!items || items.length <= 1) return;
    const id = setInterval(() => {
      Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
        setIdx((i) => (i + 1) % items.length);
        Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [items, intervalMs, fade]);
  if (!items || items.length === 0) return null;
  return (
    <Animated.Text numberOfLines={1} style={[{ opacity: fade }, style]}>
      {items[idx]}
    </Animated.Text>
  );
}

// ---- MonoTag --------------------------------------------------------------

export function MonoTag({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  const { c } = useTheme();
  return <Mono style={{ fontSize: 11, color: dim ? c.muted2 : c.muted }}>{children}</Mono>;
}

const styles = StyleSheet.create({
  tileLabel: { fontSize: 10, fontWeight: "600", letterSpacing: 0.7, marginBottom: 6 },
  fieldLabel: { fontSize: 10.5, fontWeight: "600", letterSpacing: 0.7, marginBottom: 7 },
});

// Re-export commonly used helpers for cards.
export { stateColor, toAlpha };
