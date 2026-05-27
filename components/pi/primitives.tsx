"use client";

import * as React from "react";

export type PiState = "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled";

export const STATE_COLOR: Record<PiState, string> = {
  todo: "var(--s-todo)",
  in_progress: "var(--s-progress)",
  review: "var(--s-review)",
  blocked: "var(--s-blocked)",
  done: "var(--s-done)",
  cancelled: "var(--s-cancelled)",
};

export const STATE_LABEL: Record<PiState, string> = {
  todo: "Todo",
  in_progress: "Running",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export function StateIcon({
  state,
  size = 14,
  spin = false,
}: {
  state: PiState | string;
  size?: number;
  spin?: boolean;
}) {
  const s = (state as PiState) in STATE_COLOR ? (state as PiState) : "todo";
  const color = STATE_COLOR[s];
  const sw = 1.75;
  const c = size / 2;
  const r = (size - sw) / 2;
  const svgStyle: React.CSSProperties = { display: "inline-block", verticalAlign: "middle" };
  if (s === "todo") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" style={svgStyle}>
        <circle cx={c} cy={c} r={r} stroke={color} strokeWidth={sw} />
      </svg>
    );
  }
  if (s === "in_progress") {
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        fill="none"
        style={{ ...svgStyle, animation: spin ? "pi-spin 1.6s linear infinite" : "none" }}
      >
        <circle cx={c} cy={c} r={r} stroke={color} strokeWidth={sw} opacity={0.4} />
        <path d={`M ${c} ${c} L ${c} ${sw / 2} A ${r} ${r} 0 0 1 ${c + r} ${c} Z`} fill={color} />
      </svg>
    );
  }
  if (s === "review") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" style={svgStyle}>
        <circle cx={c} cy={c} r={r} stroke={color} strokeWidth={sw} />
        <circle cx={c} cy={c} r={r * 0.34} fill={color} />
      </svg>
    );
  }
  if (s === "blocked") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" style={svgStyle}>
        <circle cx={c} cy={c} r={r} fill={color} />
        <rect x={c - r * 0.55} y={c - 0.9} width={r * 1.1} height={1.8} fill="var(--pi-bg)" rx={0.6} />
      </svg>
    );
  }
  if (s === "done") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" style={svgStyle}>
        <circle cx={c} cy={c} r={r} fill={color} />
        <path
          d={`M ${c - r * 0.5} ${c} L ${c - r * 0.1} ${c + r * 0.42} L ${c + r * 0.55} ${c - r * 0.35}`}
          stroke="var(--pi-bg)"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }
  // cancelled
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" style={svgStyle}>
      <circle cx={c} cy={c} r={r} fill={color} />
      <path
        d={`M ${c - r * 0.45} ${c - r * 0.45} L ${c + r * 0.45} ${c + r * 0.45} M ${c + r * 0.45} ${c - r * 0.45} L ${c - r * 0.45} ${c + r * 0.45}`}
        stroke="var(--pi-bg)"
        strokeWidth={sw}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function StatePill({
  state,
  label,
  size = "sm",
  live = false,
}: {
  state: PiState;
  label?: string;
  size?: "xs" | "sm";
  live?: boolean;
}) {
  const lbl = label ?? STATE_LABEL[state];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: size === "xs" ? "1px 6px 1px 5px" : "2px 8px 2px 6px",
        borderRadius: 6,
        fontSize: size === "xs" ? 11 : 12,
        fontWeight: 500,
        background: "hsla(240 4% 14% / 0.6)",
        border: "1px solid var(--pi-hairline)",
        color: "var(--pi-fg)",
        lineHeight: "16px",
      }}
    >
      <StateIcon state={state} size={size === "xs" ? 11 : 12} spin={live && state === "in_progress"} />
      <span>{lbl}</span>
    </span>
  );
}

export function MonoTag({
  children,
  dim = false,
  style = {},
}: {
  children: React.ReactNode;
  dim?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="pi-mono"
      style={{
        fontSize: 11,
        color: dim ? "var(--pi-muted-2)" : "var(--pi-muted)",
        letterSpacing: "-0.01em",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Badge({
  children,
  tone = "default",
  style = {},
}: {
  children: React.ReactNode;
  tone?: "default" | "muted" | "outline";
  style?: React.CSSProperties;
}) {
  const tones = {
    default: { bg: "hsla(240 4% 14% / 0.8)", fg: "var(--pi-fg)", border: "var(--pi-hairline)" },
    muted: { bg: "transparent", fg: "var(--pi-muted)", border: "var(--pi-hairline)" },
    outline: { bg: "transparent", fg: "var(--pi-muted)", border: "var(--pi-hairline-strong)" },
  } as const;
  const t = tones[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        lineHeight: "16px",
        letterSpacing: "0.01em",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function ProgressBar({
  value,
  max = 1,
  color,
  height = 3,
  track = "hsla(240 4% 20% / 0.6)",
}: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
  track?: string;
}) {
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <div style={{ width: "100%", height, background: track, borderRadius: 2, overflow: "hidden" }}>
      <div
        style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: color || "var(--pi-fg)",
          transition: "width 600ms cubic-bezier(0.2,0,0,1)",
        }}
      />
    </div>
  );
}

export function TokenMeter({ used, budget }: { used: number; budget: number }) {
  const pct = budget > 0 ? used / budget : 0;
  const danger = pct > 0.85;
  const warn = pct > 0.6;
  const color = danger ? "var(--s-blocked)" : warn ? "var(--s-progress)" : "var(--pi-muted)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 84 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-fg)" }}>
          ${used.toFixed(2)}
        </span>
        <span className="pi-mono" style={{ fontSize: 10, color: "var(--pi-muted-2)" }}>
          /${budget.toFixed(0)}
        </span>
      </div>
      <ProgressBar value={used} max={budget} color={color} height={2} />
    </div>
  );
}

export function Hairline({
  vertical,
  opacity = 1,
  style = {},
}: {
  vertical?: boolean;
  opacity?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--pi-hairline)",
        opacity,
        flexShrink: 0,
        ...(vertical ? { width: 1, alignSelf: "stretch" } : { height: 1, width: "100%" }),
        ...style,
      }}
    />
  );
}

export function ElapsedTimer({
  startMs,
  paused = false,
  format = "long",
}: {
  startMs: number;
  paused?: boolean;
  format?: "long" | "hms";
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused]);
  const diff = Math.max(0, Math.floor((now - startMs) / 1000));
  const h = Math.floor(diff / 3600);
  const mi = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (format === "hms") {
    return (
      <span>
        {String(h).padStart(2, "0")}:{String(mi).padStart(2, "0")}:{String(s).padStart(2, "0")}
      </span>
    );
  }
  let str = "";
  if (h) str = `${h}h ${mi}m`;
  else if (mi) str = `${mi}m ${s}s`;
  else str = `${s}s`;
  return <span>{str}</span>;
}

export function CyclingText({
  items,
  intervalMs = 3200,
  style = {},
}: {
  items: string[];
  intervalMs?: number;
  style?: React.CSSProperties;
}) {
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    if (!items || items.length <= 1) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % items.length), intervalMs);
    return () => clearInterval(id);
  }, [items, intervalMs]);
  if (!items || !items.length) return null;
  return (
    <span
      key={idx}
      style={{ display: "inline-block", animation: "pi-fade-in 240ms ease-out", ...style }}
    >
      {items[idx]}
    </span>
  );
}

export function Sparkline({
  values,
  width = 80,
  height = 18,
  color = "var(--pi-fg)",
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (!values || values.length === 0) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  );
}

/* Persona chip — small colored swatch + mono name */
const PERSONA_HUE: Record<string, number> = {
  "claude-sonnet-4.5": 25,
  "claude-opus-4.1": 25,
  "claude-opus-4.7": 25,
  "claude-haiku-4.5": 25,
  "kimi-for-coding": 200,
  "gpt-5-codex": 152,
};

export function PersonaChip({ id, size = 11 }: { id: string | null | undefined; size?: number }) {
  const name = id || "unassigned";
  const hue = (id && PERSONA_HUE[id]) ?? 240;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 3,
          background: `hsl(${hue} 8% 30%)`,
          border: `1px solid hsl(${hue} 12% 38%)`,
          display: "inline-block",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 1.5,
            background: `hsl(${hue} 35% 56%)`,
            borderRadius: 1,
          }}
        />
      </span>
      <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-muted)" }}>
        {name}
      </span>
    </span>
  );
}

/* Minimal lucide-style icon set */
type IconName =
  | "factory" | "agents" | "plans" | "tasks" | "repos" | "chat" | "personas" | "tokens"
  | "play" | "pause" | "stop" | "spark" | "search" | "branch" | "pr" | "more"
  | "x" | "chev-r" | "chev-l" | "chev-d" | "arrow-up" | "check" | "circle"
  | "circle-filled" | "flame" | "lightning" | "clock" | "edit" | "term" | "code"
  | "diff" | "user" | "folder" | "cmd" | "settings" | "filter" | "plus" | "pi"
  | "live-dot";

export function Icon({
  name,
  size = 14,
  stroke = 1.75,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
}) {
  const s = size;
  const c = stroke;
  const common = {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: c,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { display: "inline-block", verticalAlign: "middle", flexShrink: 0 },
  };
  switch (name) {
    case "factory": return <svg {...common}><path d="M3 21V10l5 3V10l5 3V10l5 3v8" /><path d="M3 21h18" /><path d="M9 17h.01M13 17h.01M17 17h.01" /></svg>;
    case "agents": return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M9 9h.01M15 9h.01" /><path d="M9 14c.83.67 1.83 1 3 1s2.17-.33 3-1" /><path d="M12 2v3" /></svg>;
    case "plans": return <svg {...common}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></svg>;
    case "tasks": return <svg {...common}><path d="M9 5h11M9 12h11M9 19h11" /><path d="M4 5h.01M4 12h.01M4 19h.01" strokeWidth={c * 1.3} /></svg>;
    case "repos": return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>;
    case "chat": return <svg {...common}><path d="M21 12a8 8 0 0 1-12.5 6.6L3 20l1.4-5.5A8 8 0 1 1 21 12z" /></svg>;
    case "personas": return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" /><path d="M16 3a3 3 0 1 1 0 6" /><path d="M21 21v-2a4 4 0 0 0-3-3.87" /></svg>;
    case "tokens": return <svg {...common}><circle cx="8" cy="15" r="6" /><path d="M14 9l4-4M14 5h4v4" /></svg>;
    case "play": return <svg {...common}><path d="M6 4l14 8L6 20z" fill="currentColor" /></svg>;
    case "pause": return <svg {...common}><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>;
    case "stop": return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" /></svg>;
    case "spark": return <svg {...common}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2" /></svg>;
    case "search": return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
    case "branch": return <svg {...common}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 8.5v7M8.5 18c5 0 9.5-3.5 9.5-9.5" /></svg>;
    case "pr": return <svg {...common}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v7M16 18a8 8 0 0 0-8-8" /></svg>;
    case "more": return <svg {...common}><circle cx="6" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="18" cy="12" r="1" fill="currentColor" /></svg>;
    case "x": return <svg {...common}><path d="M6 6l12 12M18 6 6 18" /></svg>;
    case "chev-r": return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
    case "chev-l": return <svg {...common}><path d="m15 6-6 6 6 6" /></svg>;
    case "chev-d": return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
    case "arrow-up": return <svg {...common}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
    case "check": return <svg {...common}><path d="M4 12l5 5L20 6" /></svg>;
    case "circle": return <svg {...common}><circle cx="12" cy="12" r="9" /></svg>;
    case "circle-filled": return <svg {...common}><circle cx="12" cy="12" r="9" fill="currentColor" /></svg>;
    case "flame": return <svg {...common}><path d="M12 2c1 3 3 4 3 7 0 1.5-.5 3-2 3 .5-2 .5-3-1-4-1.5 3-4 4-4 7a5 5 0 1 0 10 0c0-5-5-7-6-13z" /></svg>;
    case "lightning": return <svg {...common}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></svg>;
    case "clock": return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "edit": return <svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>;
    case "term": return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
    case "code": return <svg {...common}><path d="m8 6-6 6 6 6M16 6l6 6-6 6" /></svg>;
    case "diff": return <svg {...common}><path d="M12 3v18M3 8h6M6 5v6M15 16h6M15 19h6" /></svg>;
    case "user": return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
    case "folder": return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>;
    case "cmd": return <svg {...common}><path d="M6 9a3 3 0 1 1 3-3v12a3 3 0 1 1-3-3M18 15a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3M6 9h12M6 15h12" /></svg>;
    case "settings": return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
    case "filter": return <svg {...common}><path d="M3 5h18l-7 9v6l-4-2v-4z" /></svg>;
    case "plus": return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case "pi": return <svg {...common}><path d="M4 8h16M8 8v9a2 2 0 0 1-2 2M16 8v8c0 1.5.5 3 2 3M11 8c0 4-1.5 9-3 11" strokeWidth={c * 1.05} /></svg>;
    case "live-dot": return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "inline-block", verticalAlign: "middle" }}>
        <circle cx="12" cy="12" r="5" fill="currentColor" />
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.35">
          <animate attributeName="r" from="5" to="11" dur="1.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" from="0.6" to="0" dur="1.8s" repeatCount="indefinite" />
        </circle>
      </svg>
    );
    default: return null;
  }
}

export function fmtTok(n: number): string {
  if (n > 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n > 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/* Section header */
export function Section({
  glyph,
  glyphColor,
  title,
  count,
  meta,
  right,
  children,
}: {
  glyph?: React.ReactNode;
  glyphColor?: string;
  title: string;
  count?: number;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          paddingBottom: 8,
          borderBottom: "1px solid var(--pi-hairline)",
        }}
      >
        {glyph && <span style={{ color: glyphColor || "inherit", display: "inline-flex" }}>{glyph}</span>}
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em" }}>{title}</h2>
        {typeof count === "number" && (
          <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-muted-2)" }}>
            {String(count).padStart(2, "0")}
          </span>
        )}
        {meta && (
          <span style={{ marginLeft: 8, color: "var(--pi-muted-2)", fontSize: 11, fontWeight: 500 }}>
            · {meta}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "20px 16px",
        textAlign: "center",
        color: "var(--pi-muted-2)",
        fontSize: 12,
        fontWeight: 500,
        border: "1px dashed var(--pi-hairline)",
        borderRadius: 8,
        background: "hsla(240 4% 10% / 0.3)",
      }}
    >
      {children}
    </div>
  );
}

export function SegBar<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: "var(--pi-bg)",
        border: "1px solid var(--pi-hairline)",
        borderRadius: 5,
        padding: 2,
        gap: 1,
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: "3px 9px",
            borderRadius: 3,
            background: value === o.value ? "var(--pi-raised)" : "transparent",
            color: value === o.value ? "var(--pi-fg)" : "var(--pi-muted)",
            fontSize: 11,
            fontWeight: 500,
            border: "none",
            cursor: "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const piButtons = {
  ghost: (): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 8px",
    borderRadius: 5,
    background: "transparent",
    color: "var(--pi-muted)",
    fontSize: 11,
    fontWeight: 500,
    border: "1px solid var(--pi-hairline)",
    cursor: "pointer",
  }),
  ghostSm: (): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 10px",
    borderRadius: 6,
    background: "transparent",
    color: "var(--pi-muted)",
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid var(--pi-hairline)",
    cursor: "pointer",
  }),
  runAction: (): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    borderRadius: 4,
    background: "transparent",
    color: "var(--pi-muted)",
    fontSize: 11,
    fontWeight: 500,
    border: "1px solid var(--pi-hairline)",
    cursor: "pointer",
  }),
  runInline: (): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 10px",
    borderRadius: 5,
    background: "var(--pi-raised)",
    color: "var(--pi-fg)",
    fontSize: 11,
    fontWeight: 600,
    border: "1px solid var(--pi-hairline-strong)",
    cursor: "pointer",
  }),
  primary: (): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 12px",
    borderRadius: 6,
    background: "var(--pi-fg)",
    color: "var(--pi-bg)",
    fontSize: 12,
    fontWeight: 600,
    border: "none",
    width: "100%",
    cursor: "pointer",
  }),
  primaryInline: (): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 6,
    background: "var(--pi-fg)",
    color: "var(--pi-bg)",
    fontSize: 12,
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
  }),
};

export const piWrap: React.CSSProperties = {
  padding: "20px 20px 80px",
  maxWidth: 1480,
  margin: "0 auto",
};
