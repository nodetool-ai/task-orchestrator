import React, { useRef } from "react";
import { Animated, PanResponder, Pressable, Text, View } from "react-native";

import { Icon, type IconName } from "./Icon";
import { useTheme } from "@/theme";

export interface SwipeAction {
  label: string;
  icon: IconName;
  onPress: () => void;
  bg?: string;
  color?: string;
}

interface Props {
  children: React.ReactNode;
  actions?: SwipeAction[];
  onTap?: () => void;
  margin?: { horizontal?: number; bottom?: number };
}

const ACT_W = 76;

// Drag left to reveal trailing actions; tap to open. Ported from mobile-core SwipeRow.
export function SwipeRow({ children, actions = [], onTap, margin }: Props) {
  const { c } = useTheme();
  const W = actions.length * ACT_W;
  const tx = useRef(new Animated.Value(0)).current;
  const offset = useRef(0);

  const snap = (to: number) => {
    offset.current = to;
    Animated.spring(tx, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
  };

  const handleTap = () => {
    // A tap closes the row if it's open, otherwise opens the item. The
    // PanResponder below only claims horizontal drags, so taps fall through
    // to this Pressable and vertical drags fall through to the ScrollView.
    if (offset.current !== 0) snap(0);
    else onTap?.();
  };

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_e, g) => {
        let nx = offset.current + g.dx;
        if (nx > 0) nx = 0;
        if (nx < -W) nx = -W;
        tx.setValue(nx);
      },
      onPanResponderRelease: (_e, g) => {
        const nx = offset.current + g.dx;
        snap(nx < -W / 2 ? -W : 0);
      },
    })
  ).current;

  return (
    <View
      style={{
        position: "relative",
        marginHorizontal: margin?.horizontal ?? 16,
        marginBottom: margin?.bottom ?? 8,
        borderRadius: 16,
        overflow: "hidden",
      }}
    >
      {actions.length > 0 && (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, flexDirection: "row", width: W }}>
          {actions.map((a, i) => (
            <Pressable
              key={i}
              onPress={() => {
                snap(0);
                a.onPress();
              }}
              style={{
                width: ACT_W,
                height: "100%",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                backgroundColor: a.bg || c.raised,
              }}
            >
              <Icon name={a.icon} size={18} color={a.color || c.fg} />
              <Text style={{ fontSize: 11, fontWeight: "600", color: a.color || c.fg }}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: tx }], backgroundColor: c.surface }}>
        <Pressable onPress={handleTap}>{children}</Pressable>
      </Animated.View>
    </View>
  );
}
