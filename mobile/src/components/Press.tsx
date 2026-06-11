import React, { useRef } from "react";
import { Animated, Pressable, type StyleProp, type ViewStyle } from "react-native";

interface Props {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  scale?: number;
  dim?: number;
  disabled?: boolean;
  hitSlop?: number;
}

// Press-down feedback (scale + dim), ported from the prototype's <Press>.
export function Press({ children, onPress, style, scale = 0.975, dim = 0.6, disabled, hitSlop }: Props) {
  const v = useRef(new Animated.Value(0)).current;
  const animate = (to: number) =>
    Animated.timing(v, { toValue: to, duration: 120, useNativeDriver: true }).start();

  const animStyle = {
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, scale] }) }],
    opacity: disabled ? 0.4 : v.interpolate({ inputRange: [0, 1], outputRange: [1, dim] }),
  };

  return (
    <Pressable
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={() => animate(1)}
      onPressOut={() => animate(0)}
      onPress={onPress}
    >
      <Animated.View style={[style, animStyle]}>{children}</Animated.View>
    </Pressable>
  );
}
