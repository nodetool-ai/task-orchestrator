"use client";

import * as React from "react";
import Link from "next/link";
import {
  Hairline,
  Icon,
  MonoTag,
  PersonaChip,
  ProgressBar,
  SegBar,
  StateIcon,
  STATE_COLOR,
  STATE_LABEL,
  piButtons,
  piWrap,
  piWrapMobile,
  type PiState,
} from "./primitives";
import { openSpawn } from "./overlay-store";
import { useIsMobile } from "./use-is-mobile";
import { prShortLabel } from "@/lib/utils";

export type TaskRowData = {
  id: string;
  title: string;
  plan: string | null;
  planId: string | null;
  state: PiState;
  runDbId: number | null;
  prUrl: string | null;
  persona: string | null;
  criteria: { done: number; total: number } | null;
  tags: string[];
};

type StateFilter = "open" | "in_progress" | "review" | "blocked" | "todo" | "all";
type GroupBy = "state" | "plan" | "none";

export function TasksIndex({
  rows,
  plans,
}: {
  rows: TaskRowData[];
  plans: { id: string; title: string }[];
}) {
  const [q, setQ] = React.useState("");
  const [stateFilter, setStateFilter] = React.useState<StateFilter>("open");
  const [groupBy, setGroupBy] = React.useState<GroupBy>("state");
  const [planFilter, setPlanFilter] = React.useState<string>("");

  const counts = {
    total: rows.length,
    live: rows.filter((r) => r.state === "in_progress").length,
    queued: rows.filter((r) => r.state === "todo").length,
    done: rows.filter((r) => r.state === "done").length,
  };

  const filtered = React.useMemo(
    () =>
      rows.filter((r) => {
        if (stateFilter === "open" && (r.state === "done" || r.state === "cancelled")) return false;
        if (stateFilter !== "open" && stateFilter !== "all" && r.state !== stateFilter) return false;
        if (planFilter && r.plan !== planFilter) return false;
        if (q) {
          const ql = q.toLowerCase();
          return (
            r.id.toLowerCase().includes(ql) ||
            r.title.toLowerCase().includes(ql) ||
            (r.plan || "").toLowerCase().includes(ql)
          );
        }
        return true;
      }),
    [rows, stateFilter, planFilter, q]
  );

  const groups = React.useMemo(() => {
    const out = new Map<string, TaskRowData[]>();
    if (groupBy === "none") {
      out.set("", filtered);
      return out;
    }
    const ordered: string[] | null =
      groupBy === "state" ? ["in_progress", "review", "blocked", "todo", "done", "cancelled"] : null;
    for (const r of filtered) {
      const k = groupBy === "state" ? r.state : r.plan || "(no plan)";
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(r);
    }
    if (ordered) {
      const sorted = new Map<string, TaskRowData[]>();
      for (const k of ordered) if (out.has(k)) sorted.set(k, out.get(k)!);
      for (const [k, v] of out) if (!sorted.has(k)) sorted.set(k, v);
      return sorted;
    }
    return out;
  }, [filtered, groupBy]);

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
            Tasks
          </h1>
          <div style={{ marginTop: 4, color: "var(--pi-muted-2)", fontSize: 12 }}>
            {counts.total} total · {counts.live} live · {counts.queued} queued · {counts.done} shipped
          </div>
        </div>
        <div style={{ display: "inline-flex", gap: 8 }}>
          <button style={{ ...piButtons.ghostSm(), flex: isMobile ? 1 : undefined, justifyContent: "center" }}>
            <Icon name="plus" size={12} />
            New task
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
          padding: isMobile ? "10px 10px" : "8px 10px",
          borderRadius: 8,
          background: "var(--pi-surface)",
          border: "1px solid var(--pi-hairline)",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
          }}
        >
          <Icon name="search" size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tasks…"
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            overflowX: isMobile ? "auto" : "visible",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <span style={{ color: "var(--pi-muted-2)", fontSize: 11 }}>State</span>
          <SegBar
            value={stateFilter}
            onChange={setStateFilter}
            options={[
              { value: "open", label: "Open" },
              { value: "in_progress", label: "Running" },
              { value: "review", label: "Review" },
              { value: "blocked", label: "Stuck" },
              { value: "todo", label: "Queue" },
              { value: "all", label: "All" },
            ]}
          />
        </div>

        {!isMobile && <Hairline vertical style={{ height: 16 }} />}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "var(--pi-muted-2)", fontSize: 11 }}>Group</span>
          <SegBar
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: "state", label: "State" },
              { value: "plan", label: "Plan" },
              { value: "none", label: "None" },
            ]}
          />
          {!isMobile && <Hairline vertical style={{ height: 16 }} />}
          <select
            value={planFilter}
            onChange={(e) => setPlanFilter(e.target.value)}
            style={{
              background: "var(--pi-bg)",
              border: "1px solid var(--pi-hairline)",
              color: planFilter ? "var(--pi-fg)" : "var(--pi-muted)",
              borderRadius: 5,
              padding: "4px 8px",
              fontSize: 11,
              fontFamily: "inherit",
              outline: "none",
              maxWidth: isMobile ? 160 : undefined,
            }}
          >
            <option value="">All plans</option>
            {plans.map((p) => (
              <option key={p.id} value={p.title}>
                {p.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        style={{
          background: "var(--pi-surface)",
          border: "1px solid var(--pi-hairline)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {[...groups.entries()].map(([key, list], gi) => (
          <React.Fragment key={key + gi}>
            {key && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  background: "hsla(240 4% 11% / 0.6)",
                  borderTop: gi === 0 ? "none" : "1px solid var(--pi-hairline)",
                  borderBottom: "1px solid var(--pi-hairline)",
                  position: "sticky",
                  top: 48,
                  zIndex: 5,
                  backdropFilter: "blur(8px)",
                }}
              >
                {groupBy === "state" ? (
                  <>
                    <StateIcon state={key} size={12} spin={key === "in_progress"} />
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: STATE_COLOR[key as PiState] || "var(--pi-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}
                    >
                      {STATE_LABEL[key as PiState] ?? key}
                    </span>
                  </>
                ) : (
                  <>
                    <Icon name="plans" size={12} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{key}</span>
                  </>
                )}
                <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-muted-2)" }}>
                  {String(list.length).padStart(2, "0")}
                </span>
              </div>
            )}
            {list.map((row) => (
              <TaskRow key={row.id} row={row} isMobile={isMobile} />
            ))}
          </React.Fragment>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: "var(--pi-muted-2)", fontSize: 12 }}>
            No tasks match.
          </div>
        )}
      </div>
    </div>
  );
}

function TaskRow({ row, isMobile }: { row: TaskRowData; isMobile: boolean }) {
  const href = row.runDbId != null ? `/runs/${row.runDbId}` : `/tasks/${row.id}`;
  const isLive = row.state === "in_progress";

  if (isMobile) {
    return (
      <Link
        href={href}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "12px 12px",
          borderTop: "1px solid var(--pi-hairline)",
          textDecoration: "none",
          color: "var(--pi-fg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <StateIcon state={row.state} size={13} spin={isLive} />
          <MonoTag>{row.id}</MonoTag>
          <span style={{ flex: 1 }} />
          {row.state === "todo" && (
            <span
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openSpawn();
              }}
              style={{ ...piButtons.runInline(), padding: "4px 8px" }}
            >
              <Icon name="spark" size={11} />
              Run
            </span>
          )}
        </div>
        <span
          style={{
            fontSize: 14,
            color: "var(--pi-fg)",
            fontWeight: 500,
            lineHeight: 1.35,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {row.title}
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            color: "var(--pi-muted-2)",
            fontSize: 11,
          }}
        >
          {row.criteria && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-fg)" }}>
                {row.criteria.done}/{row.criteria.total}
              </span>
              <div style={{ width: 40 }}>
                <ProgressBar
                  value={row.criteria.done}
                  max={row.criteria.total || 1}
                  color={row.state === "done" ? "var(--s-done)" : "var(--s-progress)"}
                  height={2}
                />
              </div>
            </span>
          )}
          {row.planId && row.plan ? (
            <Link
              href={`/plans/${row.planId}`}
              onClick={(e) => e.stopPropagation()}
              style={{
                color: "var(--pi-muted)",
                fontSize: 11,
                textDecoration: "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 180,
              }}
            >
              {row.plan}
            </Link>
          ) : null}
          {row.prUrl && (
            <a
              href={row.prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={prShortLabel(row.prUrl)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: "var(--pi-muted)",
                fontSize: 11,
                textDecoration: "none",
              }}
            >
              <Icon name="pr" size={11} />
              <span className="pi-mono">{prShortLabel(row.prUrl)}</span>
            </a>
          )}
          <span style={{ flex: 1 }} />
          {row.persona ? (
            <PersonaChip id={row.persona} />
          ) : (
            <span style={{ fontSize: 11 }}>unassigned</span>
          )}
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={href}
      style={{
        display: "grid",
        gridTemplateColumns: "28px 130px 1fr 220px auto auto auto",
        gap: 14,
        alignItems: "center",
        padding: "10px 14px",
        borderTop: "1px solid var(--pi-hairline)",
        textDecoration: "none",
        color: "var(--pi-fg)",
        transition: "background 120ms",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--pi-surface-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        <StateIcon state={row.state} size={13} spin={isLive} />
      </span>
      <MonoTag>{row.id}</MonoTag>
      <span
        style={{
          fontSize: 13,
          color: "var(--pi-fg)",
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.title}
      </span>

      {row.planId ? (
        <Link
          href={`/plans/${row.planId}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            color: "var(--pi-muted)",
            fontSize: 11,
            textDecoration: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.plan || "—"}
        </Link>
      ) : (
        <span style={{ color: "var(--pi-muted-2)", fontSize: 11 }}>—</span>
      )}

      {row.criteria ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="pi-mono" style={{ fontSize: 11, color: "var(--pi-fg)" }}>
            {row.criteria.done}/{row.criteria.total}
          </span>
          <div style={{ width: 48 }}>
            <ProgressBar
              value={row.criteria.done}
              max={row.criteria.total || 1}
              color={row.state === "done" ? "var(--s-done)" : "var(--s-progress)"}
              height={2}
            />
          </div>
        </span>
      ) : (
        <span />
      )}

      <span style={{ minWidth: 130, display: "inline-flex", justifyContent: "flex-end" }}>
        {row.persona ? (
          <PersonaChip id={row.persona} />
        ) : (
          <span style={{ color: "var(--pi-muted-2)", fontSize: 11 }}>unassigned</span>
        )}
      </span>

      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {row.prUrl && (
          <a
            href={row.prUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={prShortLabel(row.prUrl)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "var(--pi-muted)",
              fontSize: 11,
              textDecoration: "none",
            }}
          >
            <Icon name="pr" size={11} />
            <span className="pi-mono">{prShortLabel(row.prUrl)}</span>
          </a>
        )}
        {row.state === "todo" && (
          <span
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openSpawn();
            }}
            style={piButtons.runInline()}
          >
            <Icon name="spark" size={11} />
            Run
          </span>
        )}
        {row.runDbId != null && row.state !== "todo" && (
          <span style={piButtons.runAction()}>
            Open
            <Icon name="chev-r" size={11} />
          </span>
        )}
      </span>
    </Link>
  );
}
