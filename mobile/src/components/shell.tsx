import React from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "./Icon";
import { StateIcon } from "./StateIcon";
import { LiveDot, Mono, Press } from "./primitives";
import { useTheme, stateColor, toAlpha, type RunState } from "@/theme";

// Frosted top bar shared by AppHeader / DetailHeader.
function FrostBar({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <BlurView
      intensity={32}
      tint={c.blurTint}
      style={[
        {
          borderBottomWidth: 1,
          borderBottomColor: c.hairline,
          backgroundColor: toAlpha(c.bg, 0.7),
        },
        style,
      ]}
    >
      {children}
    </BlurView>
  );
}

export function AppHeader({
  title,
  subtitle,
  left,
  right,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  left?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  return (
    <FrostBar style={{ paddingTop: insets.top + 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 10, minHeight: 36 }}>
        {left}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 22, fontWeight: "600", color: c.fg, letterSpacing: -0.4 }} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? <View style={{ marginTop: 2 }}>{subtitle}</View> : null}
        </View>
        {right}
      </View>
      {children}
    </FrostBar>
  );
}

export function BrandMark({ onPress }: { onPress?: () => void }) {
  const { c } = useTheme();
  const mark = (
    <View style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: c.fg, alignItems: "center", justifyContent: "center" }}>
      <Icon name="pi" size={17} stroke={2} color={c.bg} />
    </View>
  );
  if (!onPress) return mark;
  return (
    <Press onPress={onPress} hitSlop={8}>
      {mark}
    </Press>
  );
}

export function DetailHeader({
  onBack,
  backLabel = "Back",
  right,
  children,
}: {
  onBack: () => void;
  backLabel?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  return (
    <FrostBar style={{ paddingTop: insets.top + 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingBottom: 9, minHeight: 34 }}>
        <Press onPress={onBack} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4, paddingRight: 8 }}>
          <Icon name="chev-l" size={20} color={c.accent} />
          <Text style={{ fontSize: 15, fontWeight: "500", color: c.accent }}>{backLabel}</Text>
        </Press>
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {children}
    </FrostBar>
  );
}

// Floor live subtitle ("• live · 5 personas · 3 repos").
export function FloorSubtitle({ personas, repos }: { personas: number; repos: number }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <LiveDot size={9} />
        <Text style={{ color: c.sProgress, fontSize: 11.5 }}>live</Text>
      </View>
      <Text style={{ color: c.muted2 }}>·</Text>
      <Text style={{ color: c.muted, fontSize: 11.5 }}>{personas} personas</Text>
      <Text style={{ color: c.muted2 }}>·</Text>
      <Text style={{ color: c.muted, fontSize: 11.5 }}>{repos} repos</Text>
    </View>
  );
}

// Round icon button used in headers (search / more).
export function RoundButton({ icon, onPress }: { icon: Parameters<typeof Icon>[0]["name"]; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Press
      onPress={onPress}
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.hairline,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} size={16} color={c.muted} />
    </Press>
  );
}

// ---- StatusStrip ----------------------------------------------------------

export interface StatusCell {
  state: RunState;
  label: string;
  n: number;
  live?: boolean;
}

export function StatusStrip({ cells }: { cells: StatusCell[] }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.hairline,
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      {cells.map((cell, i) => (
        <View
          key={cell.label}
          style={{
            flex: 1,
            paddingVertical: 11,
            paddingHorizontal: 4,
            alignItems: "center",
            gap: 5,
            borderLeftWidth: i > 0 ? 1 : 0,
            borderLeftColor: c.hairline,
          }}
        >
          <StateIcon state={cell.state} size={13} spin={cell.live} />
          <Mono style={{ fontSize: 21, fontWeight: "500", color: c.fg, letterSpacing: -0.4 }}>
            {String(cell.n).padStart(2, "0")}
          </Mono>
          <Text style={{ fontSize: 10, fontWeight: "500", color: c.muted2 }}>{cell.label}</Text>
        </View>
      ))}
    </View>
  );
}

// ---- SegTabs --------------------------------------------------------------

export function SegTabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; badge?: number }[];
}) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: "row", padding: 3, backgroundColor: c.raised, borderRadius: 10 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Press
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              flex: 1,
              paddingVertical: 6,
              borderRadius: 8,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              backgroundColor: active ? c.surface : "transparent",
              borderWidth: active ? 1 : 0,
              borderColor: c.hairline,
            }}
          >
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: active ? c.fg : c.muted }}>{o.label}</Text>
            {o.badge != null ? (
              <Mono style={{ fontSize: 10, color: active ? c.fg : c.muted2 }}>{o.badge}</Mono>
            ) : null}
          </Press>
        );
      })}
    </View>
  );
}

export { stateColor };
