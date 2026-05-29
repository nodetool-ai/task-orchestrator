import React, { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";

import { Icon } from "./Icon";
import { useTheme } from "@/theme";

export function Spinner({ size = 22, color }: { size?: number; color?: string }) {
  const { c } = useTheme();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View style={{ transform: [{ rotate: v.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }}>
      <Icon name="spark" size={size} color={color || c.muted} />
    </Animated.View>
  );
}

export function Loading({ label }: { label?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ alignItems: "center", gap: 12 }}>
      <Spinner />
      {label ? <Text style={{ color: c.muted2, fontSize: 13 }}>{label}</Text> : null}
    </View>
  );
}
