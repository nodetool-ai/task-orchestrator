import React from "react";
import { Pressable, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type IconName } from "./Icon";
import { Press } from "./primitives";
import { useSheets } from "@/data/SheetsProvider";
import { useTheme, toAlpha } from "@/theme";

// Minimal shape of the props expo-router's <Tabs tabBar={…}> passes through.
interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (event: { type: "tabPress"; target: string; canPreventDefault: true }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
}

const META: Record<string, { label: string; icon: IconName }> = {
  index: { label: "Floor", icon: "factory" },
  review: { label: "Review", icon: "pr" },
  queue: { label: "Queue", icon: "tasks" },
  plans: { label: "Plans", icon: "plans" },
};

// Layout order with the raised Spawn action injected in the centre.
const ORDER = ["index", "review", "__spawn", "queue", "plans"];

export function TabBar({ state, navigation }: TabBarProps) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { openSpawn } = useSheets();

  const activeName = state.routes[state.index]?.name;

  return (
    <BlurView
      intensity={32}
      tint={c.blurTint}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: 9,
        paddingBottom: insets.bottom > 0 ? insets.bottom : 14,
        borderTopWidth: 1,
        borderTopColor: c.hairline,
        backgroundColor: toAlpha(c.bg, 0.7),
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      {ORDER.map((name) => {
        if (name === "__spawn") {
          return (
            <View key="__spawn" style={{ flex: 1, alignItems: "center" }}>
              <Press
                onPress={() => openSpawn(null)}
                scale={0.92}
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 23,
                  backgroundColor: c.fg,
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: -6,
                  shadowColor: "#000",
                  shadowOpacity: 0.4,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: 6,
                }}
              >
                <Icon name="spark" size={20} stroke={2} color={c.bg} />
              </Press>
            </View>
          );
        }
        const meta = META[name];
        if (!meta) return <View key={name} style={{ flex: 1 }} />;
        const active = activeName === name;
        const onPress = () => {
          const route = state.routes.find((r) => r.name === name);
          if (!route) return;
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!active && !event.defaultPrevented) navigation.navigate(route.name);
        };
        return (
          <Pressable key={name} onPress={onPress} style={{ flex: 1, alignItems: "center", gap: 3 }}>
            <Icon name={meta.icon} size={21} stroke={active ? 2 : 1.75} color={active ? c.fg : c.muted2} />
            <Text style={{ fontSize: 10, fontWeight: "600", color: active ? c.fg : c.muted2 }}>{meta.label}</Text>
          </Pressable>
        );
      })}
    </BlurView>
  );
}
