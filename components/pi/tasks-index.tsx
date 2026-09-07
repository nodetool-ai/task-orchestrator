"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Empty,
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
  type PiState,
} from "./primitives";
import { openSpawn } from "./overlay-store";
import { useIsCompact, useIsMobile } from "./use-is-mobile";
import { describe, prShortLabel } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

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
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [stateFilter, setStateFilter] = React.useState<StateFilter>("open");
  const [groupBy, setGroupBy] = React.useState<GroupBy>("state");
  const [planFilter, setPlanFilter] = React.useState<string>("");
  const [newTask, setNewTask] = React.useState(false);

  const counts = {
    total: rows.length,
    open: rows.filter((r) => r.state !== "done" && r.state !== "cancelled").length,
    completed: rows.filter((r) => r.state === "done").length,
    cancelled: rows.filter((r) => r.state === "cancelled").length,
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
  const isCompact = useIsCompact();
  const beginNewTask = () => {
    if (plans.length === 0) {
      router.push("/plans");
      return;
    }
    setNewTask(true);
  };

  return (
    <div className="pi-page-shell">
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
          <div style={{ marginTop: 4, color: "var(--pi-muted)", fontSize: 12 }}>
            {counts.total} total · {counts.open} open · {counts.completed} completed · {counts.cancelled} cancelled
          </div>
        </div>
        <div style={{ display: "inline-flex", gap: 8 }}>
          <button
            onClick={beginNewTask}
            style={{ ...piButtons.primaryInline(), flex: isMobile ? 1 : undefined, justifyContent: "center" }}
          >
            <Icon name="plus" size={12} />
            New task
          </button>
          <button
            onClick={openSpawn}
            style={{ ...piButtons.ghostSm(), flex: isMobile ? 1 : undefined, justifyContent: "center" }}
          >
            <Icon name="spark" size={12} />
            Start agent
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
              { value: "blocked", label: "Blocked" },
              { value: "todo", label: "Queued" },
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
                  {list.length}
                </span>
              </div>
            )}
            {list.map((row) => (
              <TaskRow key={row.id} row={row} isMobile={isMobile || isCompact} />
            ))}
          </React.Fragment>
        ))}
        {filtered.length === 0 && (
          rows.length === 0 ? (
            <div style={{ padding: 12 }}>
              <Empty
                title={plans.length === 0 ? "Create a plan first" : "Create your first task"}
                action={(
                  <button onClick={beginNewTask} style={piButtons.primaryInline()}>
                    <Icon name="plus" size={12} />
                    {plans.length === 0 ? "Create a plan" : "New task"}
                  </button>
                )}
              >
                {plans.length === 0
                  ? "Tasks belong to plans. Create a plan first, then add concrete units of work."
                  : "Capture a concrete unit of work, then start an agent when it is ready."}
              </Empty>
            </div>
          ) : (
            <div style={{ padding: 12 }}>
              <Empty
                title="No matching tasks"
                action={(
                  <button
                    onClick={() => { setQ(""); setStateFilter("open"); setPlanFilter(""); }}
                    style={piButtons.ghostSm()}
                  >
                    Clear filters
                  </button>
                )}
              >
                Try a different search or broaden the selected filters.
              </Empty>
            </div>
          )
        )}
      </div>
      {newTask && <NewTaskDialog plans={plans} onClose={() => setNewTask(false)} />}
    </div>
  );
}

function NewTaskDialog({ plans, onClose }: { plans: { id: string; title: string }[]; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [planId, setPlanId] = React.useState(plans[0]?.id ?? "");
  const [criteria, setCriteria] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            plan: planId || undefined,
            criteria: criteria.split("\n").map((item) => item.trim()).filter(Boolean),
          }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          setError(body.error ?? `HTTP ${response.status}`);
          return;
        }
        onClose();
        router.refresh();
      } catch (caught) {
        setError(describe(caught));
      }
    });
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    border: "1px solid var(--pi-hairline)",
    borderRadius: 6,
    background: "var(--pi-bg)",
    color: "var(--pi-fg)",
    padding: "9px 10px",
    fontFamily: "inherit",
    fontSize: 13,
    outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: 6,
    color: "var(--pi-muted)",
    fontSize: 11,
    fontWeight: 600,
  };

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100, display: "grid", placeItems: "center",
        padding: 12, background: "hsla(240 6% 4% / 0.75)", backdropFilter: "blur(6px)",
      }}
    >
      <form
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 520, maxWidth: "100%", padding: 20, borderRadius: 10,
          border: "1px solid var(--pi-hairline-strong)", background: "var(--pi-surface)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>New task</h2>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} aria-label="Close" style={{ ...piButtons.ghost(), padding: 5 }}>
            <Icon name="x" size={13} />
          </button>
        </div>
        <label style={{ display: "block", marginBottom: 14 }}>
          <span style={labelStyle}>Title</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to be done?" style={inputStyle} />
        </label>
        <label style={{ display: "block", marginBottom: 14 }}>
          <span style={labelStyle}>Plan</span>
          <select required value={planId} onChange={(event) => setPlanId(event.target.value)} style={inputStyle}>
            {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.title}</option>)}
          </select>
        </label>
        <label style={{ display: "block", marginBottom: 14 }}>
          <span style={labelStyle}>Acceptance criteria <span style={{ color: "var(--pi-muted-2)", fontWeight: 400 }}>(one per line)</span></span>
          <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={4} placeholder="Describe the completion criteria" style={{ ...inputStyle, resize: "vertical" }} />
        </label>
        {error && <div style={{ color: "var(--s-blocked)", fontSize: 12, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 14, borderTop: "1px solid var(--pi-hairline)" }}>
          <button type="button" onClick={onClose} disabled={pending} style={piButtons.ghostSm()}>Cancel</button>
          <button type="submit" disabled={pending || !title.trim()} style={{ ...piButtons.primaryInline(), opacity: pending || !title.trim() ? 0.4 : 1 }}>
            <Icon name="plus" size={12} />
            {pending ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TaskRow({ row, isMobile }: { row: TaskRowData; isMobile: boolean }) {
  const router = useRouter();
  const href = row.runDbId != null ? `/runs/${row.runDbId}` : `/tasks/${row.id}`;
  const isLive = row.state === "in_progress";
  const openRow = () => router.push(href);
  const onRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openRow();
    }
  };

  if (isMobile) {
    return (
      <div
        role="link"
        tabIndex={0}
        aria-label={`Open ${row.title}`}
        onClick={openRow}
        onKeyDown={onRowKeyDown}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "12px 12px",
          borderTop: "1px solid var(--pi-hairline)",
          textDecoration: "none",
          color: "var(--pi-fg)",
          cursor: "pointer",
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
            fontSize: 12,
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
              onClick={(event) => event.stopPropagation()}
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
          {row.prUrl && <PiPrLink url={row.prUrl} />}
          <span style={{ flex: 1 }} />
          {row.persona ? (
            <PersonaChip id={row.persona} />
          ) : (
            <span style={{ fontSize: 11 }}>unassigned</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open ${row.title}`}
      onClick={openRow}
      onKeyDown={onRowKeyDown}
      style={{
        display: "grid",
        gridTemplateColumns: "28px 130px 1fr 220px auto auto auto",
        gap: 14,
        alignItems: "center",
        minHeight: 49,
        padding: "10px 14px",
        borderTop: "1px solid var(--pi-hairline)",
        textDecoration: "none",
        color: "var(--pi-fg)",
        transition: "background 120ms",
        cursor: "pointer",
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
          onClick={(event) => event.stopPropagation()}
          style={{
            color: "var(--pi-muted)",
            fontSize: 12,
            textDecoration: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {row.plan || "—"}
        </Link>
      ) : (
        <span style={{ color: "var(--pi-muted-2)", fontSize: 11 }}>—</span>
      )}

      {row.criteria ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="pi-mono" style={{ fontSize: 12, color: "var(--pi-fg)" }}>
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
        {row.prUrl && <PiPrLink url={row.prUrl} />}
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
    </div>
  );
}

function PiPrLink({ url }: { url: string }) {
  return (
    <Tooltip content={prShortLabel(url)}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
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
        <span className="pi-mono">{prShortLabel(url)}</span>
      </a>
    </Tooltip>
  );
}
