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

export type RepoOption = { id: string; name: string };

export function PlansIndex({ plans, repos = [] }: { plans: PlanCardData[]; repos?: RepoOption[] }) {
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<"all" | "active" | "done">("all");
  const [planWithAgent, setPlanWithAgent] = React.useState(false);
  const [newPlan, setNewPlan] = React.useState(false);

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
          <button
            onClick={() => setNewPlan(true)}
            style={{ ...piButtons.ghostSm(), flex: isMobile ? 1 : undefined, justifyContent: "center" }}
          >
            <Icon name="plus" size={12} />
            New plan
          </button>
          <button
            onClick={() => setPlanWithAgent(true)}
            style={{ ...piButtons.ghostSm(), flex: isMobile ? 1 : undefined, justifyContent: "center" }}
          >
            <Icon name="spark" size={12} />
            Plan with agent
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

      {planWithAgent && (
        <PlanWithAgentDialog repos={repos} onClose={() => setPlanWithAgent(false)} />
      )}
      {newPlan && <NewPlanDialog repos={repos} onClose={() => setNewPlan(false)} />}
    </div>
  );
}

function PlanWithAgentDialog({ repos, onClose }: { repos: RepoOption[]; onClose: () => void }) {
  const router = useRouter();
  const [idea, setIdea] = React.useState("");
  const [repoId, setRepoId] = React.useState(repos[0]?.id ?? "");
  const [reasoning, setReasoning] = React.useState<"" | "low" | "medium" | "high" | "xhigh">("");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const isMobile = useIsMobile();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  React.useEffect(() => {
    const id = window.setTimeout(() => textareaRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  const submit = () => {
    setError(null);
    const text = idea.trim();
    if (!text) { setError("Please describe your idea."); return; }
    startTransition(async () => {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "<plan>",
          personaId: "planning-agent",
          cwdStrategy: repoId ? "repo" : "none",
          repoId: repoId || null,
          thinkingLevel: reasoning || null,
          initialPrompt: text,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const run = (await res.json()) as { id: number };
      router.push(`/runs/${run.id}`);
    });
  };

  const fieldLabelSt: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--pi-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: 6,
  };
  const inputSt: React.CSSProperties = {
    width: "100%",
    background: "var(--pi-bg)",
    border: "1px solid var(--pi-hairline)",
    borderRadius: 6,
    padding: "8px 10px",
    color: "var(--pi-fg)",
    fontFamily: "inherit",
    fontSize: 13,
    outline: "none",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "hsla(240 6% 4% / 0.75)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: isMobile ? "flex-start" : "center",
        justifyContent: "center",
        padding: isMobile ? "8px" : 0,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: isMobile ? "100%" : "calc(100vw - 40px)",
          background: "var(--pi-surface)",
          border: "1px solid var(--pi-hairline-strong)",
          borderRadius: 12,
          boxShadow: "0 24px 80px hsla(0 0% 0% / 0.6)",
          animation: "pi-fade-in 200ms ease-out",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--pi-hairline)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Icon name="spark" size={14} />
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--pi-fg)" }}>Plan with agent</h2>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "var(--pi-muted)", cursor: "pointer" }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ padding: isMobile ? 14 : 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={fieldLabelSt}>Your idea</div>
            <textarea
              ref={textareaRef}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              rows={5}
              placeholder="Describe what you want to build or change…"
              style={{
                ...inputSt,
                resize: "vertical",
                fontFamily: "inherit",
                lineHeight: 1.55,
              }}
            />
          </div>

          {repos.length > 0 && (
            <div>
              <div style={fieldLabelSt}>Repository (optional)</div>
              <select
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
                style={inputSt}
              >
                <option value="">No repo</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <div style={fieldLabelSt}>Reasoning (optional)</div>
            <select
              value={reasoning}
              onChange={(e) => setReasoning(e.target.value as typeof reasoning)}
              style={inputSt}
            >
              <option value="">Persona default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: "var(--s-blocked)" }}>{error}</div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              paddingTop: 8,
              borderTop: "1px solid var(--pi-hairline)",
            }}
          >
            <button
              onClick={onClose}
              disabled={pending}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                background: "transparent",
                color: "var(--pi-muted)",
                fontSize: 12,
                fontWeight: 500,
                border: "1px solid var(--pi-hairline)",
                cursor: "pointer",
                fontFamily: "inherit",
                opacity: pending ? 0.4 : 1,
              }}
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={pending || !idea.trim()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 6,
                background: "var(--pi-fg)",
                color: "var(--pi-bg)",
                fontWeight: 600,
                fontSize: 12,
                border: "none",
                cursor: pending || !idea.trim() ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                opacity: pending || !idea.trim() ? 0.4 : 1,
              }}
            >
              <Icon name="spark" size={12} />
              {pending ? "Starting…" : "Plan with agent"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewPlanDialog({ repos, onClose }: { repos: RepoOption[]; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [repoId, setRepoId] = React.useState(repos[0]?.id ?? "");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const titleRef = React.useRef<HTMLInputElement | null>(null);
  const isMobile = useIsMobile();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  React.useEffect(() => {
    const id = window.setTimeout(() => titleRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  const submit = () => {
    setError(null);
    const t = title.trim();
    if (!t) { setError("Please enter a title."); return; }
    startTransition(async () => {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t,
          body: body.trim() || undefined,
          repoIds: repoId ? [repoId] : undefined,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? `HTTP ${res.status}`);
        return;
      }
      const created = (await res.json()) as { id: string };
      router.push(`/plans/${created.id}`);
    });
  };

  const fieldLabelSt: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--pi-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: 6,
  };
  const inputSt: React.CSSProperties = {
    width: "100%",
    background: "var(--pi-bg)",
    border: "1px solid var(--pi-hairline)",
    borderRadius: 6,
    padding: "8px 10px",
    color: "var(--pi-fg)",
    fontFamily: "inherit",
    fontSize: 13,
    outline: "none",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "hsla(240 6% 4% / 0.75)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: isMobile ? "flex-start" : "center",
        justifyContent: "center",
        padding: isMobile ? "8px" : 0,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: isMobile ? "100%" : "calc(100vw - 40px)",
          background: "var(--pi-surface)",
          border: "1px solid var(--pi-hairline-strong)",
          borderRadius: 12,
          boxShadow: "0 24px 80px hsla(0 0% 0% / 0.6)",
          animation: "pi-fade-in 200ms ease-out",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--pi-hairline)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Icon name="plus" size={14} />
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--pi-fg)" }}>New plan</h2>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "var(--pi-muted)", cursor: "pointer" }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ padding: isMobile ? 14 : 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={fieldLabelSt}>Title</div>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="What is this plan about?"
              style={inputSt}
            />
          </div>

          <div>
            <div style={fieldLabelSt}>Goal / approach (optional)</div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Markdown supported…"
              style={{ ...inputSt, resize: "vertical", lineHeight: 1.55 }}
            />
          </div>

          {repos.length > 0 && (
            <div>
              <div style={fieldLabelSt}>Repository (optional)</div>
              <select value={repoId} onChange={(e) => setRepoId(e.target.value)} style={inputSt}>
                <option value="">No repo</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          )}

          {error && <div style={{ fontSize: 12, color: "var(--s-blocked)" }}>{error}</div>}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              paddingTop: 8,
              borderTop: "1px solid var(--pi-hairline)",
            }}
          >
            <button
              onClick={onClose}
              disabled={pending}
              style={{
                padding: "8px 12px",
                borderRadius: 6,
                background: "transparent",
                color: "var(--pi-muted)",
                fontSize: 12,
                fontWeight: 500,
                border: "1px solid var(--pi-hairline)",
                cursor: "pointer",
                fontFamily: "inherit",
                opacity: pending ? 0.4 : 1,
              }}
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={pending || !title.trim()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 6,
                background: "var(--pi-fg)",
                color: "var(--pi-bg)",
                fontWeight: 600,
                fontSize: 12,
                border: "none",
                cursor: pending || !title.trim() ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                opacity: pending || !title.trim() ? 0.4 : 1,
              }}
            >
              <Icon name="plus" size={12} />
              {pending ? "Creating…" : "Create plan"}
            </button>
          </div>
        </div>
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
