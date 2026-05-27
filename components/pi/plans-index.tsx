"use client";

import * as React from "react";
import Link from "next/link";
import {
  Empty,
  Hairline,
  Icon,
  MonoTag,
  PersonaChip,
  ProgressBar,
  SegBar,
  StateIcon,
  StatePill,
  piButtons,
  piWrap,
  piWrapMobile,
  type PiState,
} from "./primitives";
import { openSpawn } from "./overlay-store";
import { useIsMobile } from "./use-is-mobile";

export type PlanCardData = {
  id: string;
  title: string;
  state: PiState;
  goal: string;
  owner: string | null;
  done: number;
  total: number;
  liveRuns: number;
  reviewRuns: number;
  blockedRuns: number;
  queueCount: number;
  shippedCount: number;
  activePersonas: string[];
};

export function PlansIndex({ plans }: { plans: PlanCardData[] }) {
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<"all" | "active" | "done">("all");

  const filtered = React.useMemo(() => {
    const out = plans.filter((p) => {
      if (filter === "active" && (p.state === "done" || p.state === "cancelled")) return false;
      if (filter === "done" && p.state !== "done") return false;
      if (q) {
        const ql = q.toLowerCase();
        return p.title.toLowerCase().includes(ql) || p.id.toLowerCase().includes(ql);
      }
      return true;
    });
    const order: Record<string, number> = {
      in_progress: 0,
      review: 1,
      blocked: 2,
      todo: 3,
      done: 4,
      cancelled: 5,
    };
    out.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
    return out;
  }, [plans, filter, q]);

  const counts = {
    total: plans.length,
    active: plans.filter((p) => p.state === "in_progress").length,
    done: plans.filter((p) => p.state === "done").length,
  };

  const isMobile = useIsMobile();

  return (
    <div style={isMobile ? piWrapMobile : piWrap}>
      <div
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "baseline",
          justifyContent: "space-between",
          gap: isMobile ? 12 : 24,
          marginBottom: isMobile ? 12 : 18,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: isMobile ? 18 : 20, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--pi-fg)" }}>
            Plans
          </h1>
          <div style={{ marginTop: 4, color: "var(--pi-muted-2)", fontSize: 12 }}>
            {counts.total} total · {counts.active} active · {counts.done} shipped
          </div>
        </div>
        <div style={{ display: "inline-flex", gap: 8 }}>
          <button style={{ ...piButtons.ghostSm(), flex: isMobile ? 1 : undefined, justifyContent: "center" }}>
            <Icon name="plus" size={12} />
            New plan
          </button>
          <button
            onClick={openSpawn}
            style={{ ...piButtons.primaryInline(), flex: isMobile ? 1 : undefined, justifyContent: "center" }}
          >
            <Icon name="spark" size={12} />
            Spawn agent
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: isMobile ? "stretch" : "center",
          flexDirection: isMobile ? "column" : "row",
          gap: 10,
          marginBottom: 14,
          padding: "8px 10px",
          borderRadius: 8,
          background: "var(--pi-surface)",
          border: "1px solid var(--pi-hairline)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <Icon name="search" size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search plans…"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--pi-fg)",
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
        </div>
        {!isMobile && <Hairline vertical style={{ height: 16 }} />}
        <SegBar
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "done", label: "Done" },
          ]}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map((p) => (
          <PlanCard key={p.id} plan={p} isMobile={isMobile} />
        ))}
        {filtered.length === 0 && <Empty>No plans match.</Empty>}
      </div>
    </div>
  );
}

function PlanCard({ plan, isMobile }: { plan: PlanCardData; isMobile: boolean }) {
  const pct = plan.total > 0 ? plan.done / plan.total : 0;
  return (
    <Link
      href={`/plans/${plan.id}`}
      style={{
        background: "var(--pi-surface)",
        border: "1px solid var(--pi-hairline)",
        borderRadius: 8,
        padding: isMobile ? "14px 14px" : "16px 18px",
        textDecoration: "none",
        color: "var(--pi-fg)",
        display: "block",
        transition: "border-color 120ms, background 120ms",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--pi-hairline-strong)";
        e.currentTarget.style.background = "var(--pi-surface-2)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--pi-hairline)";
        e.currentTarget.style.background = "var(--pi-surface)";
      }}
    >
      <div
        style={{
          display: isMobile ? "flex" : "grid",
          gridTemplateColumns: isMobile ? undefined : "1fr auto",
          flexDirection: isMobile ? "column" : undefined,
          gap: isMobile ? 12 : 16,
          alignItems: isMobile ? "stretch" : "flex-start",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <MonoTag>{plan.id}</MonoTag>
            <StatePill state={plan.state} live={plan.state === "in_progress"} size="xs" />
            {plan.owner && <span style={{ color: "var(--pi-muted-2)", fontSize: 12 }}>@{plan.owner}</span>}
          </div>
          <h3
            style={{
              margin: "8px 0 6px",
              fontSize: isMobile ? 15 : 16,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--pi-fg)",
              lineHeight: 1.3,
            }}
          >
            {plan.title}
          </h3>
          {plan.goal && (
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: "var(--pi-muted)",
                lineHeight: 1.5,
                maxWidth: isMobile ? "100%" : 760,
                ...(isMobile && {
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical" as const,
                  overflow: "hidden",
                }),
              }}
            >
              {plan.goal}
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "row" : "column",
            alignItems: isMobile ? "center" : "flex-end",
            gap: isMobile ? 10 : 8,
            minWidth: isMobile ? 0 : 160,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span
              className="pi-mono"
              style={{ fontSize: isMobile ? 16 : 18, fontWeight: 500, color: "var(--pi-fg)", letterSpacing: "-0.02em" }}
            >
              {plan.done}
            </span>
            <span className="pi-mono" style={{ fontSize: 13, color: "var(--pi-muted-2)" }}>
              / {plan.total}
            </span>
            <span style={{ color: "var(--pi-muted-2)", marginLeft: 2, fontSize: 12 }}>done</span>
          </div>
          <div style={{ flex: isMobile ? 1 : undefined, width: isMobile ? undefined : 160 }}>
            <ProgressBar
              value={plan.done}
              max={plan.total || 1}
              color={plan.state === "done" ? "var(--s-done)" : "var(--s-progress)"}
              height={3}
            />
          </div>
          <div className="pi-mono" style={{ fontSize: 10, color: "var(--pi-muted-2)" }}>
            {Math.round(pct * 100)}%
          </div>
        </div>
      </div>

      <div style={{ height: 14 }} />
      <Hairline opacity={0.6} />
      <div style={{ height: 12 }} />

      <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <StatChip
          glyph={<Icon name="live-dot" size={11} />}
          glyphColor="var(--s-progress)"
          value={plan.liveRuns}
          label="running"
          muted={plan.liveRuns === 0}
        />
        <StatChip
          glyph={<StateIcon state="review" size={11} />}
          value={plan.reviewRuns}
          label="review"
          muted={plan.reviewRuns === 0}
        />
        <StatChip
          glyph={<StateIcon state="blocked" size={11} />}
          value={plan.blockedRuns}
          label="stuck"
          muted={plan.blockedRuns === 0}
        />
        <StatChip
          glyph={<StateIcon state="todo" size={11} />}
          value={plan.queueCount}
          label="queued"
          muted={plan.queueCount === 0}
        />
        <StatChip
          glyph={<StateIcon state="done" size={11} />}
          value={plan.done + plan.shippedCount}
          label="shipped"
          muted
        />

        <div style={{ flex: 1 }} />

        {plan.activePersonas.length > 0 && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--pi-muted-2)", fontSize: 12 }}>agents:</span>
            <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
              {plan.activePersonas.map((p) => (
                <PersonaChip key={p} id={p} />
              ))}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

function StatChip({
  glyph,
  glyphColor,
  value,
  label,
  muted,
}: {
  glyph: React.ReactNode;
  glyphColor?: string;
  value: number;
  label: string;
  muted?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: muted ? "var(--pi-muted-2)" : "var(--pi-fg)",
      }}
    >
      <span style={{ color: glyphColor || (muted ? "var(--pi-muted-2)" : "var(--pi-muted)") }}>{glyph}</span>
      <span className="pi-mono" style={{ fontSize: 12, fontWeight: 500 }}>
        {String(value).padStart(2, "0")}
      </span>
      <span style={{ fontSize: 11, color: "var(--pi-muted-2)" }}>{label}</span>
    </span>
  );
}
