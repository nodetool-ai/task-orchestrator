import React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { useTheme } from "@/theme";

export type IconName =
  | "factory"
  | "plans"
  | "tasks"
  | "pr"
  | "spark"
  | "search"
  | "branch"
  | "clock"
  | "edit"
  | "term"
  | "code"
  | "user"
  | "check"
  | "x"
  | "chev-r"
  | "chev-l"
  | "chev-d"
  | "more"
  | "play"
  | "pause"
  | "stop"
  | "plus"
  | "flame"
  | "pi"
  | "circle"
  | "live-dot"
  | "logout"
  | "server"
  | "moon";

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  stroke?: number;
}

// Minimal lucide-style strokes, ported from factory-primitives.jsx.
export function Icon({ name, size = 16, color, stroke = 1.75 }: Props) {
  const { c } = useTheme();
  const col = color || c.fg;
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
  };
  const s = {
    stroke: col,
    strokeWidth: stroke,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const fillCol = { fill: col };

  switch (name) {
    case "factory":
      return (
        <Svg {...common}>
          <Path {...s} d="M3 21V10l5 3V10l5 3V10l5 3v8" />
          <Path {...s} d="M3 21h18" />
          <Path {...s} d="M9 17h.01M13 17h.01M17 17h.01" />
        </Svg>
      );
    case "plans":
      return (
        <Svg {...common}>
          <Circle {...s} cx="12" cy="12" r="9" />
          <Circle {...s} cx="12" cy="12" r="5" />
          <Circle {...fillCol} cx="12" cy="12" r="1" />
        </Svg>
      );
    case "tasks":
      return (
        <Svg {...common}>
          <Path {...s} d="M9 5h11M9 12h11M9 19h11" />
          <Path {...s} strokeWidth={stroke * 1.3} d="M4 5h.01M4 12h.01M4 19h.01" />
        </Svg>
      );
    case "pr":
      return (
        <Svg {...common}>
          <Circle {...s} cx="6" cy="6" r="2.5" />
          <Circle {...s} cx="6" cy="18" r="2.5" />
          <Circle {...s} cx="18" cy="18" r="2.5" />
          <Path {...s} d="M6 8.5v7M16 18a8 8 0 0 0-8-8" />
        </Svg>
      );
    case "spark":
      return (
        <Svg {...common}>
          <Path
            {...s}
            d="M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2"
          />
        </Svg>
      );
    case "search":
      return (
        <Svg {...common}>
          <Circle {...s} cx="11" cy="11" r="7" />
          <Path {...s} d="m20 20-3.5-3.5" />
        </Svg>
      );
    case "branch":
      return (
        <Svg {...common}>
          <Circle {...s} cx="6" cy="6" r="2.5" />
          <Circle {...s} cx="18" cy="6" r="2.5" />
          <Circle {...s} cx="6" cy="18" r="2.5" />
          <Path {...s} d="M6 8.5v7M8.5 18c5 0 9.5-3.5 9.5-9.5" />
        </Svg>
      );
    case "clock":
      return (
        <Svg {...common}>
          <Circle {...s} cx="12" cy="12" r="9" />
          <Path {...s} d="M12 7v5l3 2" />
        </Svg>
      );
    case "edit":
      return (
        <Svg {...common}>
          <Path {...s} d="M12 20h9" />
          <Path {...s} d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </Svg>
      );
    case "term":
      return (
        <Svg {...common}>
          <Rect {...s} x="3" y="4" width="18" height="16" rx="2" />
          <Path {...s} d="m7 9 3 3-3 3M13 15h4" />
        </Svg>
      );
    case "code":
      return (
        <Svg {...common}>
          <Path {...s} d="m8 6-6 6 6 6M16 6l6 6-6 6" />
        </Svg>
      );
    case "user":
      return (
        <Svg {...common}>
          <Circle {...s} cx="12" cy="8" r="4" />
          <Path {...s} d="M4 21a8 8 0 0 1 16 0" />
        </Svg>
      );
    case "check":
      return (
        <Svg {...common}>
          <Path {...s} d="M4 12l5 5L20 6" />
        </Svg>
      );
    case "x":
      return (
        <Svg {...common}>
          <Path {...s} d="M6 6l12 12M18 6 6 18" />
        </Svg>
      );
    case "chev-r":
      return (
        <Svg {...common}>
          <Path {...s} d="m9 6 6 6-6 6" />
        </Svg>
      );
    case "chev-l":
      return (
        <Svg {...common}>
          <Path {...s} d="m15 6-6 6 6 6" />
        </Svg>
      );
    case "chev-d":
      return (
        <Svg {...common}>
          <Path {...s} d="m6 9 6 6 6-6" />
        </Svg>
      );
    case "more":
      return (
        <Svg {...common}>
          <Circle {...fillCol} cx="6" cy="12" r="1" />
          <Circle {...fillCol} cx="12" cy="12" r="1" />
          <Circle {...fillCol} cx="18" cy="12" r="1" />
        </Svg>
      );
    case "play":
      return (
        <Svg {...common}>
          <Path {...s} {...fillCol} d="M6 4l14 8L6 20z" />
        </Svg>
      );
    case "pause":
      return (
        <Svg {...common}>
          <Rect {...fillCol} x="6" y="5" width="4" height="14" rx="1" />
          <Rect {...fillCol} x="14" y="5" width="4" height="14" rx="1" />
        </Svg>
      );
    case "stop":
      return (
        <Svg {...common}>
          <Rect {...fillCol} x="6" y="6" width="12" height="12" rx="1" />
        </Svg>
      );
    case "plus":
      return (
        <Svg {...common}>
          <Path {...s} d="M12 5v14M5 12h14" />
        </Svg>
      );
    case "flame":
      return (
        <Svg {...common}>
          <Path
            {...s}
            d="M12 2c1 3 3 4 3 7 0 1.5-.5 3-2 3 .5-2 .5-3-1-4-1.5 3-4 4-4 7a5 5 0 1 0 10 0c0-5-5-7-6-13z"
          />
        </Svg>
      );
    case "pi":
      return (
        <Svg {...common}>
          <Path
            {...s}
            strokeWidth={stroke * 1.05}
            d="M4 8h16M8 8v9a2 2 0 0 1-2 2M16 8v8c0 1.5.5 3 2 3M11 8c0 4-1.5 9-3 11"
          />
        </Svg>
      );
    case "live-dot":
      return (
        <Svg {...common}>
          <Circle {...fillCol} cx="12" cy="12" r="5" />
        </Svg>
      );
    case "logout":
      return (
        <Svg {...common}>
          <Path {...s} d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <Path {...s} d="M16 17l5-5-5-5M21 12H9" />
        </Svg>
      );
    case "server":
      return (
        <Svg {...common}>
          <Rect {...s} x="3" y="4" width="18" height="7" rx="2" />
          <Rect {...s} x="3" y="13" width="18" height="7" rx="2" />
          <Path {...s} d="M7 7.5h.01M7 16.5h.01" />
        </Svg>
      );
    case "moon":
      return (
        <Svg {...common}>
          <Path {...s} d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </Svg>
      );
    case "circle":
      return (
        <Svg {...common}>
          <Circle {...s} cx="12" cy="12" r="9" />
        </Svg>
      );
    default:
      return null;
  }
}
