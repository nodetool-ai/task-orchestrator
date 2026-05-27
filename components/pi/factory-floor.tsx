"use client";

import * as React from "react";
import Link from "next/link";
import {
  CyclingText,
  ElapsedTimer,
  Empty,
  fmtTok,
  Hairline,
  Icon,
  MonoTag,
  PersonaChip,
  ProgressBar,
  Section,
  StateIcon,
  StatePill,
  TokenMeter,
  Sparkline,
  Badge,
  piButtons,
  piWrap,
  type PiState,
} from "./primitives";

export type FloorRun = {
  id: string;
  runDbId?: number;
  state: "in_progress" | "review" | "blocked";
  sub?: "editing" | "tool" | "thinking" | "starting" | "budget" | "criteria";
  task: { id: string; title: string };
  plan: string | null;
  persona: string | null;
  branch: string | null;
  pr: { num: number; title: string; additions: number; deletions: number } | null;
  startedAt: number;
  cost: number;
  budget: number;
  tokens: { in: number; out: number };
  progress: { done: number; total: number };
  activity: string[];
  sparkline: number[];
  reason?: string;
};

export type ShippedRow = {
  id: string;
  runDbId?: number;
  task: string;
  plan: string | null;
  persona: string | null;
  branch: string | null;
  pr: number | null;
  cost: number;
  finishedAt: number;
  diff: { additions: number; deletions: number };
};

export type QueueRow = {
  id: string;
  title: string;
  plan: string | null;
  criteria: number;
  tags: string[];
  persona: string | null;
};

export function FactoryFloor({
  running,
  review,
  blocked,
  queue,
  shipped,
}: {
  running: FloorRun[];
  review: FloorRun[];
  blocked: FloorRun[];
  queue: QueueRow[];
  shipped: ShippedRow[];
}) {
  const totalCost =
    running.reduce((s, r) => s + r.cost, 0) +
    review.reduce((s, r) => s + r.cost, 0) +
    blocked.reduce((s, r) => s + r.cost, 0) +
    shipped.reduce((s, r) => s + r.cost, 0);
  const tokIn = [...running, ...review, ...blocked].reduce((s, r) => s + r.tokens.in, 0);
  const tokOut = [...running, ...review, ...blocked].reduce((s, r) => s + r.tokens.out, 0);

  const personasActive = new Set(
    [...running, ...review, ...blocked].map((r) => r.persona).filter(Boolean) as string[]
  );

  return (
    <div style={piWrap}>
      <FloorHeader
        running={running.length}
        review={review.length}
        blocked={blocked.length}
        queue={queue.length}
        shipped={shipped.length}
        cost={totalCost}
        tokIn={tokIn}
        tokOut={tokOut}
        personasActive={personasActive.size}
      />

      <div style={{ height: 24 }} />

      <Section
        glyph={<Icon name="live-dot" size={12} />}
        glyphColor="var(--s-progress)"
        title="On the floor"
        count={running.length}
        meta={
          running.length > 0 ? (
            <CyclingText items={["streaming tokens", "tools in flight", "live agents"]} />
          ) : null
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {running.length === 0 && <Empty>No live agents. Spawn one to start the line.</Empty>}
          {running.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </div>
      </Section>

      <div style={{ height: 28 }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Section
          glyph={<StateIcon state="review" size={13} />}
          title="Needs your review"
          count={review.length}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {review.map((r) => (
              <ReviewRow key={r.id} run={r} />
            ))}
            {review.length === 0 && <Empty>No PRs waiting.</Empty>}
          </div>
        </Section>

        <Section
          glyph={<StateIcon state="blocked" size={13} />}
          title="Stuck"
          count={blocked.length}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {blocked.map((r) => (
              <BlockedRow key={r.id} run={r} />
            ))}
            {blocked.length === 0 && <Empty>Nothing stuck.</Empty>}
          </div>
        </Section>
      </div>

      <div style={{ height: 28 }} />

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 24 }}>
        <Section
          glyph={<StateIcon state="todo" size={13} />}
          title="Queue"
          count={queue.length}
          right={
            <Link href="/tasks?state=todo" style={{ ...piButtons.ghost(), textDecoration: "none" }}>
              <Icon name="filter" size={12} />
              All
            </Link>
          }
        >
          <QueueTable queue={queue} />
        </Section>

        <Section
          glyph={<StateIcon state="done" size={13} />}
          title="Shipped recently"
          count={shipped.length}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {shipped.length === 0 && <Empty>Nothing shipped yet.</Empty>}
            {shipped.map((s) => (
              <ShippedRowView key={s.id} run={s} />
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function FloorHeader({
  running,
  review,
  blocked,
  queue,
  shipped,
  cost,
  tokIn,
  tokOut,
  personasActive,
}: {
  running: number;
  review: number;
  blocked: number;
  queue: number;
  shipped: number;
  cost: number;
  tokIn: number;
  tokOut: number;
  personasActive: number;
}) {
  const cells: { state: PiState; label: string; n: number; live?: boolean }[] = [
    { state: "in_progress", label: "Running", n: running, live: running > 0 },
    { state: "review", label: "Review", n: review },
    { state: "blocked", label: "Stuck", n: blocked },
    { state: "todo", label: "Queue", n: queue },
    { state: "done", label: "Shipped", n: shipped },
  ];

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 24,
          marginBottom: 12,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--pi-fg)" }}>
            Factory floor
          </h1>
          <div
            style={{
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              fontWeight: 500,
              color: "var(--pi-muted)",
            }}
          >
            <span
              style={{
                color: "var(--s-progress)",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Icon name="live-dot" size={10} /> live
            </span>
            <span>·</span>
            <span>{personasActive} personas active</span>
          </div>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
          <KPI label="Cost today" value={`$${cost.toFixed(2)}`} />
          <Hairline vertical style={{ height: 24 }} />
          <KPI label="Tokens in" value={fmtTok(tokIn)} />
          <KPI label="Tokens out" value={fmtTok(tokOut)} />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cells.length}, 1fr)`,
          background: "var(--pi-surface)",
          border: "1px solid var(--pi-hairline)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {cells.map((c, i) => (
          <div
            key={c.state}
            style={{
              padding: "12px 16px",
              borderLeft: i > 0 ? "1px solid var(--pi-hairline)" : "none",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <StateIcon state={c.state} size={12} spin={c.live} />
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--pi-muted)" }}>{c.label}</span>
            </div>
            <span
              className="pi-mono"
              style={{
                fontSize: 22,
                fontWeight: 500,
                color: "var(--pi-fg)",
                letterSpacing: "-0.02em",
              }}
            >
              {String(c.n).padStart(2, "0")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KPI({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 1,
        whiteSpace: "nowrap",
      }}
    >
      <span className="pi-mono" style={{ fontSize: 13, color: "var(--pi-fg)", fontWeight: 500 }}>
        {value}
      </span>
      <span
        style={{
          fontSize: 10,
          color: "var(--pi-muted-2)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 500,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function runHref(r: FloorRun): string {
  return r.runDbId != null ? `/runs/${r.runDbId}` : "#";
}

function RunRow({ run }: { run: FloorRun }) {
  const subLabel =
    ({ editing: "Editing", tool: "Tool", thinking: "Thinking", starting: "Starting" } as Record<string, string>)[
      run.sub || ""
    ] || "Active";

  return (
    <Link
      href={runHref(run)}
      style={{
        position: "relative",
        background: "var(--pi-surface)",
        border: "1px solid var(--pi-hairline)",
        borderRadius: 8,
        padding: "12px 16px",
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
          display: "grid",
          gridTemplateColumns: "auto 110px 1fr auto auto auto",
          gap: 16,
          alignItems: "center",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <StateIcon state="in_progress" size={14} spin />
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--s-progress)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {subLabel}
          </span>
        </span>

        <MonoTag>{run.id}</MonoTag>

        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: "var(--pi-fg)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {run.task.title}
          </span>
        </div>

        <PersonaChip id={run.persona} />

        <span
          className="pi-mono"
          style={{
            fontSize: 11,
            color: "var(--pi-muted)",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Icon name="clock" size={11} />
          <ElapsedTimer startMs={run.startedAt} />
        </span>

        <div style={{ minWidth: 96 }}>
          <TokenMeter used={run.cost} budget={run.budget || 25} />
        </div>
      </div>

      <div style={{ height: 10 }} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto auto",
          gap: 16,
          alignItems: "center",
        }}
      >
        <MonoTag style={{ color: "var(--pi-muted-2)" }}>{run.task.id}</MonoTag>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            overflow: "hidden",
            color: "var(--pi-muted)",
            fontSize: 12,
          }}
        >
          <Icon
            name={
              run.sub === "editing"
                ? "edit"
                : run.sub === "tool"
                ? "term"
                : run.sub === "thinking"
                ? "spark"
                : "circle"
            }
            size={12}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <CyclingText items={run.activity.length ? run.activity : ["Working…"]} intervalMs={3000} />
          </span>
        </div>

        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-fg)" }}>
            {run.progress.done}/{run.progress.total || "—"}
          </span>
          <span style={{ color: "var(--pi-muted-2)", fontSize: 11 }}>criteria</span>
          <div style={{ width: 64 }}>
            <ProgressBar
              value={run.progress.done}
              max={run.progress.total || 1}
              color="var(--s-progress)"
              height={2}
            />
          </div>
        </span>

        <Sparkline values={run.sparkline} width={72} height={16} color="var(--s-progress)" />
      </div>

      <div style={{ height: 8 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 14, color: "var(--pi-muted-2)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Icon name="branch" size={11} />
          <span className="pi-mono" style={{ fontSize: 11 }}>
            {run.branch || "—"}
          </span>
        </span>
        <span className="pi-mono" style={{ fontSize: 11 }}>
          {fmtTok(run.tokens.in)}↓ {fmtTok(run.tokens.out)}↑
        </span>
        <span style={{ flex: 1 }} />
        <span style={piButtons.runAction()} onClick={(e) => e.preventDefault()}>
          <Icon name="pause" size={11} />
          Pause
        </span>
        <span style={piButtons.runAction()} onClick={(e) => e.preventDefault()}>
          <Icon name="stop" size={11} />
          Stop
        </span>
        <span style={piButtons.runAction()}>
          Open
          <Icon name="chev-r" size={11} />
        </span>
      </div>
    </Link>
  );
}

function ReviewRow({ run }: { run: FloorRun }) {
  return (
    <Link
      href={runHref(run)}
      style={{
        background: "var(--pi-surface)",
        border: "1px solid var(--pi-hairline)",
        borderRadius: 8,
        padding: "12px 14px",
        textDecoration: "none",
        color: "var(--pi-fg)",
        display: "block",
        transition: "border-color 120ms",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--pi-hairline-strong)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--pi-hairline)")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatePill state="review" label={run.pr ? "PR open" : "Review"} size="xs" />
        {run.pr && (
          <span className="pi-mono" style={{ fontSize: 11, color: "var(--s-review)", fontWeight: 500 }}>
            #{run.pr.num}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <PersonaChip id={run.persona} />
      </div>
      <div style={{ height: 8 }} />
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          lineHeight: 1.35,
          color: "var(--pi-fg)",
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {run.task.title}
      </div>
      <div style={{ height: 10 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--pi-muted-2)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Icon name="branch" size={11} />
          <span className="pi-mono" style={{ fontSize: 11 }}>
            {run.branch || "—"}
          </span>
        </span>
        {run.pr && (
          <>
            <span className="pi-mono" style={{ fontSize: 11, color: "var(--s-done)" }}>
              +{run.pr.additions}
            </span>
            <span className="pi-mono" style={{ fontSize: 11, color: "var(--s-blocked)" }}>
              −{run.pr.deletions}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span className="pi-mono" style={{ fontSize: 11 }}>
          ${run.cost.toFixed(2)}
        </span>
      </div>
    </Link>
  );
}

function BlockedRow({ run }: { run: FloorRun }) {
  return (
    <Link
      href={runHref(run)}
      style={{
        background: "var(--pi-surface)",
        border: "1px solid var(--pi-hairline)",
        borderRadius: 8,
        padding: "12px 14px",
        textDecoration: "none",
        color: "var(--pi-fg)",
        display: "block",
        transition: "border-color 120ms",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--pi-hairline-strong)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--pi-hairline)")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatePill state="blocked" label={run.sub === "budget" ? "Budget" : "Criteria"} size="xs" />
        <MonoTag>{run.id}</MonoTag>
        <span style={{ flex: 1 }} />
        <PersonaChip id={run.persona} />
      </div>
      <div style={{ height: 8 }} />
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          lineHeight: 1.35,
          color: "var(--pi-fg)",
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {run.task.title}
      </div>
      {run.reason && (
        <>
          <div style={{ height: 8 }} />
          <div style={{ fontSize: 11, color: "var(--s-blocked)", lineHeight: 1.4 }}>{run.reason}</div>
        </>
      )}
      <div style={{ height: 10 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={piButtons.runAction()}>
          <Icon name="play" size={10} />
          Resume
        </span>
        <span style={piButtons.runAction()}>Reassign</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            color: "var(--pi-muted-2)",
          }}
        >
          <Icon name="branch" size={11} />
          <span className="pi-mono" style={{ fontSize: 11 }}>
            {run.branch || "—"}
          </span>
        </span>
      </div>
    </Link>
  );
}

function QueueTable({ queue }: { queue: QueueRow[] }) {
  if (queue.length === 0) {
    return <Empty>Queue empty.</Empty>;
  }
  return (
    <div
      style={{
        background: "var(--pi-surface)",
        border: "1px solid var(--pi-hairline)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {queue.map((t, i) => (
        <Link
          key={t.id}
          href={`/tasks/${t.id}`}
          style={{
            display: "grid",
            gridTemplateColumns: "auto 130px 1fr auto auto auto auto",
            gap: 14,
            alignItems: "center",
            padding: "10px 14px",
            borderTop: i === 0 ? "none" : "1px solid var(--pi-hairline)",
            textDecoration: "none",
            color: "var(--pi-fg)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--pi-surface-2)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <StateIcon state="todo" size={12} />
          <MonoTag>{t.id}</MonoTag>
          <span
            style={{
              fontSize: 13,
              color: "var(--pi-fg)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {t.title}
          </span>
          <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-muted)" }}>
            {t.criteria} criteria
          </span>
          <span style={{ display: "inline-flex", gap: 4 }}>
            {t.tags.slice(0, 2).map((tg) => (
              <Badge key={tg} tone="muted">
                {tg}
              </Badge>
            ))}
          </span>
          <span style={{ minWidth: 130 }}>
            {t.persona ? (
              <PersonaChip id={t.persona} />
            ) : (
              <span style={{ color: "var(--pi-muted-2)", fontSize: 11 }}>unassigned</span>
            )}
          </span>
          <span style={piButtons.runInline()} onClick={(e) => e.preventDefault()}>
            <Icon name="spark" size={11} />
            Run
          </span>
        </Link>
      ))}
    </div>
  );
}

function ShippedRowView({ run }: { run: ShippedRow }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto auto",
        gap: 12,
        alignItems: "center",
        padding: "8px 12px",
        background: "var(--pi-surface)",
        border: "1px solid var(--pi-hairline)",
        borderRadius: 6,
      }}
    >
      <StateIcon state="done" size={12} />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: "var(--pi-fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {run.task}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 2,
            color: "var(--pi-muted-2)",
          }}
        >
          {run.pr != null && (
            <span className="pi-mono" style={{ fontSize: 10, color: "var(--s-review)" }}>
              #{run.pr}
            </span>
          )}
          <span className="pi-mono" style={{ fontSize: 10, color: "var(--s-done)" }}>
            +{run.diff.additions}
          </span>
          <span className="pi-mono" style={{ fontSize: 10, color: "var(--s-blocked)" }}>
            −{run.diff.deletions}
          </span>
        </div>
      </div>
      <PersonaChip id={run.persona} />
      <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-muted)" }}>
        ${run.cost.toFixed(2)}
      </span>
    </div>
  );
}
