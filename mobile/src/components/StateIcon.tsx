import React, { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { useTheme, stateColor, type RunState } from "@/theme";

interface Props {
  state: RunState;
  size?: number;
  spin?: boolean;
}

// Linear-style status glyph, ported from factory-primitives.jsx StateIcon.
export function StateIcon({ state, size = 14, spin = false }: Props) {
  const { c } = useTheme();
  const color = stateColor(c, state);
  const bg = c.bg;
  const sw = 1.75;
  const cc = size / 2;
  const r = (size - sw) / 2;

  const spinning = spin && state === "in_progress";
  const rot = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning) return;
    const loop = Animated.loop(
      Animated.timing(rot, {
        toValue: 1,
        duration: 1600,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [spinning, rot]);

  let glyph: React.ReactNode = null;
  if (state === "todo") {
    glyph = <Circle cx={cc} cy={cc} r={r} stroke={color} strokeWidth={sw} fill="none" />;
  } else if (state === "in_progress") {
    glyph = (
      <>
        <Circle cx={cc} cy={cc} r={r} stroke={color} strokeWidth={sw} opacity={0.4} fill="none" />
        <Path d={`M ${cc} ${cc} L ${cc} ${sw / 2} A ${r} ${r} 0 0 1 ${cc + r} ${cc} Z`} fill={color} />
      </>
    );
  } else if (state === "review") {
    glyph = (
      <>
        <Circle cx={cc} cy={cc} r={r} stroke={color} strokeWidth={sw} fill="none" />
        <Circle cx={cc} cy={cc} r={r * 0.34} fill={color} />
      </>
    );
  } else if (state === "blocked") {
    glyph = (
      <>
        <Circle cx={cc} cy={cc} r={r} fill={color} />
        <Rect x={cc - r * 0.55} y={cc - 0.9} width={r * 1.1} height={1.8} fill={bg} rx={0.6} />
      </>
    );
  } else if (state === "done") {
    glyph = (
      <>
        <Circle cx={cc} cy={cc} r={r} fill={color} />
        <Path
          d={`M ${cc - r * 0.5} ${cc} L ${cc - r * 0.1} ${cc + r * 0.42} L ${cc + r * 0.55} ${cc - r * 0.35}`}
          stroke={bg}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </>
    );
  } else if (state === "cancelled") {
    glyph = (
      <>
        <Circle cx={cc} cy={cc} r={r} fill={color} />
        <Path
          d={`M ${cc - r * 0.45} ${cc - r * 0.45} L ${cc + r * 0.45} ${cc + r * 0.45} M ${cc + r * 0.45} ${cc - r * 0.45} L ${cc - r * 0.45} ${cc + r * 0.45}`}
          stroke={bg}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </>
    );
  }

  const svg = (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      {glyph}
    </Svg>
  );

  if (!spinning) return svg;
  const spinStyle = {
    transform: [
      {
        rotate: rot.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }),
      },
    ],
  };
  return <Animated.View style={spinStyle}>{svg}</Animated.View>;
}
