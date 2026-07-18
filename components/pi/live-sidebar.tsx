"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tooltip } from "@/components/ui/tooltip";
import { Icon, StateIcon, ElapsedTimer, type PiState } from "./primitives";
import { useIsMobile } from "./use-is-mobile";

export type LiveSessionItem = {
  runDbId: number;
  shortId: string;
  bucket: "running" | "review" | "blocked";
  title: string;
  taskId: string | null;
  /** Set for plan-executor runs (goal <execute>), which have no taskId. */
  planId: string | null;
  branch: string | null;
  prNum: number | null;
  persona: string | null;
  cost: number;
  startedAt: number;
  reason: string | null;
};

/** A normal chat conversation (goal '<chat>'), not tied to a task or plan. */
export type ChatSidebarItem = {
  runDbId: number;
  title: string;
  running: boolean;
  startedAt: number;
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
  chats: ChatSidebarItem[];
  loading: boolean;
  error: string | null;
};

function useLiveSessions(enabled: boolean): SidebarState {
  const [state, setState] = React.useState<SidebarState>({
    items: [],
    chats: [],
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
        const data = (await res.json()) as { items: LiveSessionItem[]; chats: ChatSidebarItem[] };
        if (cancelled) return;
        setState({ items: data.items, chats: data.chats ?? [], loading: false, error: null });
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
  const { items: rawItems, chats, error } = useLiveSessions(enabled && !isMobile);

  // Optimistic dismissal: closing a run PATCHes it to `closed` (which drops it
  // from the next poll), but the poll is 6s away — track dismissed runs locally
  // so the card disappears the instant the X is clicked. A failed close reverts.
  const [dismissed, setDismissed] = React.useState<ReadonlySet<number>>(new Set());
  const items = React.useMemo(
    () => rawItems.filter((i) => !dismissed.has(i.runDbId)),
    [rawItems, dismissed]
  );

  const closeRun = React.useCallback(async (runDbId: number) => {
    setDismissed((prev) => new Set(prev).add(runDbId));
    try {
      const res = await fetch(`/api/runs/${runDbId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Revert on failure so the run reappears rather than silently vanishing.
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(runDbId);
        return next;
      });
    }
  }, []);

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
  // Hide on the Factory floor — the floor already surfaces review/stuck items.
  if (pathname === "/") return null;

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
        {items.length === 0 && chats.length === 0 && !error && (
          <EmptyState collapsed={collapsed} />
        )}
        {items.map((item) =>
          collapsed ? (
            <SidebarPip key={item.runDbId} item={item} active={isActive(pathname, item.runDbId)} />
          ) : (
            <SidebarRow
              key={item.runDbId}
              item={item}
              active={isActive(pathname, item.runDbId)}
              onClose={closeRun}
            />
          )
        )}
        {error && !collapsed && (
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--s-blocked)" }}>
            sidebar offline: {error}
          </div>
        )}
        {chats.length > 0 && (
          <>
            {!collapsed && items.length > 0 && (
              <div
                style={{
                  height: 1,
                  background: "var(--pi-hairline)",
                  margin: "6px 2px",
                  flexShrink: 0,
                }}
              />
            )}
            {!collapsed && (
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--pi-muted-2)",
                  padding: "4px 6px",
                }}
              >
                Chats
              </div>
            )}
            {chats.map((chatItem) =>
              collapsed ? (
                <ChatPip key={chatItem.runDbId} item={chatItem} active={isActive(pathname, chatItem.runDbId)} />
              ) : (
                <ChatRow key={chatItem.runDbId} item={chatItem} active={isActive(pathname, chatItem.runDbId)} />
              )
            )}
          </>
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
            <Tooltip content={`${attention} need attention`}>
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
              >
                {attention}
              </span>
            </Tooltip>
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

function SidebarRow({
  item,
  active,
  onClose,
}: {
  item: LiveSessionItem;
  active: boolean;
  onClose: (runDbId: number) => void;
}) {
  const state = BUCKET_TO_STATE[item.bucket];
  const [hover, setHover] = React.useState(false);
  return (
    <div
      className={ringClass(item.bucket)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        borderRadius: 6,
        border: "1px solid var(--pi-hairline)",
        background: active ? "var(--pi-surface-2)" : "var(--pi-surface)",
        transition: "border-color 120ms, background 120ms",
        ...ringVar(item.bucket),
      }}
    >
      <Link
        href={`/runs/${item.runDbId}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 8px",
          // Reserve room on the right so the title never slides under the X.
          paddingRight: 26,
          borderRadius: 6,
          textDecoration: "none",
          color: "var(--pi-fg)",
          minWidth: 0,
        }}
      >
        <StateIcon state={state} size={11} spin={item.bucket === "running"} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 500,
            color: "var(--pi-fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </span>
        <span
          className="pi-mono"
          style={{ fontSize: 10, color: "var(--pi-muted-2)", flexShrink: 0 }}
        >
          <ElapsedTimer startMs={item.startedAt} />
        </span>
      </Link>
      <Tooltip content="Close run" side="bottom">
        <button
          type="button"
          aria-label="Close run"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClose(item.runDbId);
          }}
          style={{
            position: "absolute",
            top: "50%",
            right: 5,
            transform: "translateY(-50%)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: 4,
            background: "transparent",
            border: "none",
            color: "var(--pi-muted-2)",
            cursor: "pointer",
            fontFamily: "inherit",
            opacity: hover ? 1 : 0,
            transition: "opacity 120ms, color 120ms",
          }}
        >
          <Icon name="x" size={11} />
        </button>
      </Tooltip>
    </div>
  );
}

function SidebarPip({ item, active }: { item: LiveSessionItem; active: boolean }) {
  const state = BUCKET_TO_STATE[item.bucket];
  const attention = ATTENTION_BUCKETS.has(item.bucket);
  // In collapsed mode a pip is a self-contained icon button, not a row, so the
  // `pi-attention` left bar doesn't apply — it reads as a clipped card when the
  // pip is only ~40px wide. Signal attention with a state-tinted fill/border.
  const stateColor = `var(--s-${item.bucket})`;
  return (
    <Tooltip content={`${BUCKET_LABEL[item.bucket]}: ${item.title}`} side="right">
      <Link
        href={`/runs/${item.runDbId}`}
        aria-label={`${BUCKET_LABEL[item.bucket]}: ${item.title}`}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: 34,
          borderRadius: 8,
          border: `1px solid ${
            active
              ? "var(--pi-hairline-strong)"
              : attention
                ? `color-mix(in srgb, ${stateColor} 34%, transparent)`
                : "var(--pi-hairline)"
          }`,
          background: attention
            ? `color-mix(in srgb, ${stateColor} 12%, var(--pi-surface))`
            : active
              ? "var(--pi-surface-2)"
              : "var(--pi-surface)",
          textDecoration: "none",
          color: "var(--pi-fg)",
          transition: "border-color 120ms, background 120ms",
        }}
      >
        <StateIcon state={state} size={14} spin={item.bucket === "running"} />
      </Link>
    </Tooltip>
  );
}

function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ChatRow({ item, active }: { item: ChatSidebarItem; active: boolean }) {
  return (
    <Link
      href={`/runs/${item.runDbId}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 6,
        border: "1px solid var(--pi-hairline)",
        background: active ? "var(--pi-surface-2)" : "var(--pi-surface)",
        textDecoration: "none",
        color: "var(--pi-fg)",
        transition: "border-color 120ms, background 120ms",
      }}
    >
      <Icon name="chat" size={13} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.title}
      </span>
      {item.running ? (
        <StateIcon state="in_progress" size={11} spin />
      ) : (
        <span className="pi-mono" style={{ fontSize: 9, color: "var(--pi-muted-2)", flexShrink: 0 }}>
          {timeAgo(item.startedAt)}
        </span>
      )}
    </Link>
  );
}

function ChatPip({ item, active }: { item: ChatSidebarItem; active: boolean }) {
  return (
    <Tooltip content={item.title} side="right">
      <Link
        href={`/runs/${item.runDbId}`}
        aria-label={item.title}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: 34,
          borderRadius: 8,
          border: `1px solid ${active ? "var(--pi-hairline-strong)" : "var(--pi-hairline)"}`,
          background: active ? "var(--pi-surface-2)" : "var(--pi-surface)",
          textDecoration: "none",
          color: item.running ? "var(--pi-fg)" : "var(--pi-muted)",
          transition: "border-color 120ms, background 120ms",
        }}
      >
        <Icon name="chat" size={14} />
      </Link>
    </Tooltip>
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
