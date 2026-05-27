"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, StateIcon, MonoTag, ElapsedTimer, type PiState } from "./primitives";
import { useIsMobile } from "./use-is-mobile";

export type LiveSessionItem = {
  runDbId: number;
  shortId: string;
  bucket: "running" | "review" | "blocked";
  title: string;
  taskId: string | null;
  branch: string | null;
  prNum: number | null;
  persona: string | null;
  cost: number;
  startedAt: number;
  reason: string | null;
};

const POLL_MS = 6000;
const COLLAPSE_KEY = "pi-live-sidebar-collapsed";

const BUCKET_TO_STATE: Record<LiveSessionItem["bucket"], PiState> = {
  running: "in_progress",
  review: "review",
  blocked: "blocked",
};

const BUCKET_LABEL: Record<LiveSessionItem["bucket"], string> = {
  running: "Running",
  review: "Review",
  blocked: "Stuck",
};

const ATTENTION_BUCKETS: ReadonlySet<LiveSessionItem["bucket"]> = new Set(["review", "blocked"]);

export const SIDEBAR_WIDTH_EXPANDED = 248;
export const SIDEBAR_WIDTH_COLLAPSED = 52;

type SidebarState = {
  items: LiveSessionItem[];
  loading: boolean;
  error: string | null;
};

function useLiveSessions(enabled: boolean): SidebarState {
  const [state, setState] = React.useState<SidebarState>({
    items: [],
    loading: enabled,
    error: null,
  });

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch("/api/live-sessions", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items: LiveSessionItem[] };
        if (cancelled) return;
        setState({ items: data.items, loading: false, error: null });
      } catch (e) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: e instanceof Error ? e.message : "fetch failed",
        }));
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, POLL_MS);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return state;
}

export function LiveSidebar({ enabled }: { enabled: boolean }) {
  const isMobile = useIsMobile();
  const pathname = usePathname() ?? "";
  const [collapsed, setCollapsed] = React.useState<boolean>(false);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    setHydrated(true);
    try {
      const stored = localStorage.getItem(COLLAPSE_KEY);
      if (stored === "1") setCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed, hydrated]);

  // Render nothing while we don't know the mobile state, to keep SSR/CSR stable.
  // The layout reserves space via CSS so this won't cause layout shift on desktop.
  const { items, error } = useLiveSessions(enabled && !isMobile);

  // ⌘J / Ctrl-J → cycle to next attention-needing run.
  React.useEffect(() => {
    if (isMobile || !enabled) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "j") return;
      const attention = items.filter((i) => ATTENTION_BUCKETS.has(i.bucket));
      if (attention.length === 0) return;
      e.preventDefault();
      const currentMatch = pathname.match(/\/runs\/(\d+)/);
      const currentId = currentMatch ? parseInt(currentMatch[1], 10) : null;
      const idx = currentId != null ? attention.findIndex((a) => a.runDbId === currentId) : -1;
      const next = attention[(idx + 1) % attention.length];
      if (next) {
        window.location.href = `/runs/${next.runDbId}`;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, pathname, isMobile, enabled]);

  if (isMobile || !enabled) return null;

  const width = collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;
  const attentionCount = items.filter((i) => ATTENTION_BUCKETS.has(i.bucket)).length;

  return (
    <aside
      aria-label="Live sessions"
      style={{
        position: "sticky",
        top: 48,
        alignSelf: "start",
        width,
        height: "calc(100vh - 48px)",
        borderRight: "1px solid var(--pi-hairline)",
        background: "hsla(240 6% 7% / 0.6)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        transition: "width 160ms cubic-bezier(0.2,0,0,1)",
        overflow: "hidden",
      }}
    >
      <SidebarHeader
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        total={items.length}
        attention={attentionCount}
      />
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: collapsed ? "8px 6px" : "8px 8px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {items.length === 0 && !error && (
          <EmptyState collapsed={collapsed} />
        )}
        {items.map((item) =>
          collapsed ? (
            <SidebarPip key={item.runDbId} item={item} active={isActive(pathname, item.runDbId)} />
          ) : (
            <SidebarRow key={item.runDbId} item={item} active={isActive(pathname, item.runDbId)} />
          )
        )}
        {error && !collapsed && (
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--s-blocked)" }}>
            sidebar offline: {error}
          </div>
        )}
      </div>
      {!collapsed && attentionCount > 0 && <SidebarFooter attention={attentionCount} />}
    </aside>
  );
}

function isActive(pathname: string, runDbId: number): boolean {
  return new RegExp(`^/runs/${runDbId}(?:$|/)`).test(pathname);
}

function SidebarHeader({
  collapsed,
  onToggle,
  total,
  attention,
}: {
  collapsed: boolean;
  onToggle: () => void;
  total: number;
  attention: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: collapsed ? "10px 8px" : "10px 12px",
        borderBottom: "1px solid var(--pi-hairline)",
        flexShrink: 0,
      }}
    >
      {!collapsed && (
        <>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--pi-muted-2)",
            }}
          >
            Live
          </span>
          <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-muted)" }}>
            {total}
          </span>
          {attention > 0 && (
            <span
              className="pi-mono"
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 999,
                background: "hsla(0 65% 55% / 0.16)",
                color: "var(--s-blocked)",
                border: "1px solid hsla(0 65% 55% / 0.32)",
                fontWeight: 600,
              }}
              title={`${attention} need attention`}
            >
              {attention}
            </span>
          )}
          <span style={{ flex: 1 }} />
        </>
      )}
      <button
        type="button"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={onToggle}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          borderRadius: 4,
          background: "transparent",
          border: "1px solid var(--pi-hairline)",
          color: "var(--pi-muted)",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <Icon name={collapsed ? "chev-r" : "chev-l"} size={12} />
      </button>
    </div>
  );
}

function EmptyState({ collapsed }: { collapsed: boolean }) {
  if (collapsed) return null;
  return (
    <div
      style={{
        marginTop: 16,
        padding: "0 8px",
        fontSize: 11,
        color: "var(--pi-muted-2)",
        lineHeight: 1.5,
      }}
    >
      No live agents. Sessions appear here while running, awaiting review, or stuck.
    </div>
  );
}

function ringClass(bucket: LiveSessionItem["bucket"]): string {
  return ATTENTION_BUCKETS.has(bucket) ? "pi-attention" : "";
}

function ringVar(bucket: LiveSessionItem["bucket"]): React.CSSProperties {
  if (!ATTENTION_BUCKETS.has(bucket)) return {};
  return { ["--s-attn" as string]: `var(--s-${bucket})` } as React.CSSProperties;
}

function SidebarRow({ item, active }: { item: LiveSessionItem; active: boolean }) {
  const state = BUCKET_TO_STATE[item.bucket];
  return (
    <Link
      href={`/runs/${item.runDbId}`}
      className={ringClass(item.bucket)}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "9px 10px",
        borderRadius: 6,
        border: "1px solid var(--pi-hairline)",
        background: active ? "var(--pi-surface-2)" : "var(--pi-surface)",
        textDecoration: "none",
        color: "var(--pi-fg)",
        transition: "border-color 120ms, background 120ms",
        ...ringVar(item.bucket),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <StateIcon state={state} size={11} spin={item.bucket === "running"} />
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: `var(--s-${item.bucket === "running" ? "progress" : item.bucket})`,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            flexShrink: 0,
          }}
        >
          {BUCKET_LABEL[item.bucket]}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="pi-mono"
          style={{
            fontSize: 10,
            color: "var(--pi-muted-2)",
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            flexShrink: 0,
          }}
        >
          <Icon name="clock" size={9} />
          <ElapsedTimer startMs={item.startedAt} />
        </span>
      </div>

      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: "var(--pi-fg)",
          lineHeight: 1.35,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {item.title}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--pi-muted-2)",
          fontSize: 10,
          flexWrap: "wrap",
        }}
      >
        {item.taskId && <MonoTag style={{ fontSize: 9, padding: "1px 5px" }}>{item.taskId}</MonoTag>}
        {item.prNum != null && (
          <span
            className="pi-mono"
            style={{ color: "var(--s-review)", fontWeight: 500 }}
            title="Pull request"
          >
            #{item.prNum}
          </span>
        )}
        {item.branch && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0, overflow: "hidden" }}
          >
            <Icon name="branch" size={10} />
            <span
              className="pi-mono"
              style={{
                fontSize: 10,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 120,
              }}
            >
              {item.branch}
            </span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        {item.cost > 0 && (
          <span className="pi-mono" style={{ fontSize: 10 }}>
            ${item.cost.toFixed(2)}
          </span>
        )}
      </div>

      {item.reason && (
        <div style={{ fontSize: 10, color: "var(--s-blocked)", lineHeight: 1.4 }}>{item.reason}</div>
      )}
    </Link>
  );
}

function SidebarPip({ item, active }: { item: LiveSessionItem; active: boolean }) {
  const state = BUCKET_TO_STATE[item.bucket];
  return (
    <Link
      href={`/runs/${item.runDbId}`}
      title={`${BUCKET_LABEL[item.bucket]} — ${item.title}`}
      aria-label={`${BUCKET_LABEL[item.bucket]}: ${item.title}`}
      className={ringClass(item.bucket)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 32,
        borderRadius: 6,
        border: "1px solid var(--pi-hairline)",
        background: active ? "var(--pi-surface-2)" : "var(--pi-surface)",
        textDecoration: "none",
        color: "var(--pi-fg)",
        ...ringVar(item.bucket),
      }}
    >
      <StateIcon state={state} size={13} spin={item.bucket === "running"} />
    </Link>
  );
}

function SidebarFooter({ attention }: { attention: number }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderTop: "1px solid var(--pi-hairline)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        color: "var(--pi-muted)",
        fontSize: 10,
        flexShrink: 0,
      }}
    >
      <span>
        {attention} need{attention === 1 ? "s" : ""} attention
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
        <kbd style={kbdStyle}>⌘</kbd>
        <kbd style={kbdStyle}>J</kbd>
      </span>
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  font: "inherit",
  color: "var(--pi-muted-2)",
  padding: "1px 4px",
  border: "1px solid var(--pi-hairline)",
  borderRadius: 3,
  fontSize: 9,
};
