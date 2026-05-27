"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon, MonoTag, StateIcon, type PiState, STATE_COLOR } from "./primitives";
import { closePalette, closeSpawn, useOverlay } from "./overlay-store";

type CmdItem = {
  kind: "Run" | "Task" | "Plan" | "Action";
  id: string;
  title: string;
  sub?: string;
  state?: PiState | string;
  href?: string;
  onClick?: () => void;
};

export function PiOverlays({ items, personaIds }: { items: CmdItem[]; personaIds: string[] }) {
  const { palette, spawn } = useOverlay();
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closePalette();
        closeSpawn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {palette && <CommandPalette items={items} />}
      {spawn && <SpawnModal personaIds={personaIds} />}
    </>
  );
}

function CommandPalette({ items }: { items: CmdItem[] }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = React.useMemo(() => {
    if (!q.trim()) return items;
    const ql = q.toLowerCase();
    return items.filter(
      (i) =>
        i.id.toLowerCase().includes(ql) ||
        i.title.toLowerCase().includes(ql) ||
        (i.sub || "").toLowerCase().includes(ql) ||
        i.kind.toLowerCase().includes(ql)
    );
  }, [q, items]);

  const onPick = (it: CmdItem) => {
    closePalette();
    if (it.onClick) it.onClick();
    else if (it.href) router.push(it.href);
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
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
      onClick={closePalette}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640,
          maxWidth: "calc(100vw - 40px)",
          background: "var(--pi-surface)",
          border: "1px solid var(--pi-hairline-strong)",
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: "0 24px 80px hsla(0 0% 0% / 0.6)",
          animation: "pi-fade-in 160ms ease-out",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderBottom: "1px solid var(--pi-hairline)",
          }}
        >
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) {
                e.preventDefault();
                onPick(filtered[0]);
              }
            }}
            placeholder="Search runs, tasks, plans, or run a command…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--pi-fg)",
              fontSize: 14,
              fontFamily: "inherit",
            }}
          />
          <kbd
            style={{
              font: "inherit",
              color: "var(--pi-muted-2)",
              padding: "1px 6px",
              border: "1px solid var(--pi-hairline)",
              borderRadius: 4,
              fontSize: 10,
            }}
          >
            esc
          </kbd>
        </div>
        <div style={{ maxHeight: 400, overflowY: "auto", padding: 6 }}>
          {filtered.length === 0 && (
            <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--pi-muted-2)", fontSize: 12 }}>
              No matches.
            </div>
          )}
          {filtered.slice(0, 12).map((it, i) => (
            <button
              key={i}
              onClick={() => onPick(it)}
              style={{
                width: "100%",
                textAlign: "left",
                display: "grid",
                gridTemplateColumns: "auto 60px 1fr auto",
                gap: 12,
                alignItems: "center",
                padding: "8px 10px",
                borderRadius: 6,
                background: "transparent",
                border: "none",
                color: "var(--pi-fg)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--pi-raised)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  color: (it.state && (STATE_COLOR as Record<string, string>)[it.state]) || "var(--pi-muted)",
                }}
              >
                <StateIcon state={(it.state as PiState) || "todo"} size={12} />
              </span>
              <span className="pi-mono" style={{ fontSize: 10, color: "var(--pi-muted-2)" }}>
                {it.kind}
              </span>
              <span style={{ overflow: "hidden" }}>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--pi-fg)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.title}
                </div>
                <div
                  style={{
                    color: "var(--pi-muted-2)",
                    fontSize: 11,
                    marginTop: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.sub}
                </div>
              </span>
              <MonoTag>{it.id.length > 18 ? it.id.slice(0, 18) + "…" : it.id}</MonoTag>
            </button>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "8px 14px",
            borderTop: "1px solid var(--pi-hairline)",
            color: "var(--pi-muted-2)",
            fontSize: 11,
          }}
        >
          <span style={{ display: "inline-flex", gap: 12 }}>
            <span>
              <kbd style={kbdSt}>↑</kbd> <kbd style={kbdSt}>↓</kbd> navigate
            </span>
            <span>
              <kbd style={kbdSt}>↵</kbd> open
            </span>
          </span>
          <span>{filtered.length} results</span>
        </div>
      </div>
    </div>
  );
}

const kbdSt: React.CSSProperties = {
  font: "inherit",
  color: "var(--pi-muted)",
  padding: "0 4px",
  border: "1px solid var(--pi-hairline)",
  borderRadius: 3,
  fontSize: 10,
};

function SpawnModal({ personaIds }: { personaIds: string[] }) {
  const [persona, setPersona] = React.useState(personaIds[0] || "claude-opus-4.7");
  const [budget, setBudget] = React.useState(25);
  const [autoPR, setAutoPR] = React.useState(true);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "hsla(240 6% 4% / 0.75)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={closeSpawn}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720,
          maxWidth: "calc(100vw - 40px)",
          maxHeight: "calc(100vh - 80px)",
          overflow: "auto",
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
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--pi-fg)" }}>Spawn agent</h2>
          <span style={{ color: "var(--pi-muted-2)", fontSize: 12 }}>· launches in a fresh worktree</span>
          <span style={{ flex: 1 }} />
          <button
            onClick={closeSpawn}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--pi-muted)",
              cursor: "pointer",
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          <Field label="Task">
            <button
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 12px",
                borderRadius: 6,
                textAlign: "left",
                background: "var(--pi-bg)",
                border: "1px solid var(--pi-hairline)",
                color: "var(--pi-muted)",
                fontSize: 13,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <StateIcon state="todo" size={12} />
              <span style={{ flex: 1 }}>Pick a task from the queue…</span>
              <Icon name="chev-d" size={12} />
            </button>
          </Field>

          <Field label="Persona">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {personaIds.slice(0, 9).map((p) => (
                <button
                  key={p}
                  onClick={() => setPersona(p)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: persona === p ? "var(--pi-raised)" : "var(--pi-bg)",
                    border: `1px solid ${persona === p ? "var(--pi-hairline-strong)" : "var(--pi-hairline)"}`,
                    color: persona === p ? "var(--pi-fg)" : "var(--pi-muted)",
                    fontSize: 11,
                    fontWeight: 500,
                    fontFamily: "var(--font-mono), ui-monospace, monospace",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  {p}
                </button>
              ))}
              {personaIds.length === 0 && (
                <span style={{ color: "var(--pi-muted-2)", fontSize: 12 }}>
                  No personas defined yet.
                </span>
              )}
            </div>
          </Field>

          <Field label="Initial prompt">
            <textarea
              defaultValue={`Pick up the task from the queue.\n\nFollow the acceptance criteria literally. Open a PR when all criteria pass.`}
              rows={4}
              style={{
                width: "100%",
                resize: "vertical",
                background: "var(--pi-bg)",
                border: "1px solid var(--pi-hairline)",
                borderRadius: 6,
                padding: "10px 12px",
                color: "var(--pi-fg)",
                fontFamily: "var(--font-mono), ui-monospace, monospace",
                fontSize: 11,
                lineHeight: 1.55,
                outline: "none",
              }}
            />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Field label="Budget cap">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="pi-mono" style={{ fontSize: 13, color: "var(--pi-muted-2)" }}>
                  $
                </span>
                <input
                  type="number"
                  value={budget}
                  onChange={(e) => setBudget(+e.target.value)}
                  style={{
                    flex: 1,
                    background: "var(--pi-bg)",
                    border: "1px solid var(--pi-hairline)",
                    borderRadius: 6,
                    padding: "8px 10px",
                    color: "var(--pi-fg)",
                    fontFamily: "var(--font-mono), ui-monospace, monospace",
                    fontSize: 13,
                    outline: "none",
                  }}
                />
                <span style={{ color: "var(--pi-muted-2)", fontSize: 12 }}>USD</span>
              </div>
            </Field>
            <Field label="On completion">
              <button
                onClick={() => setAutoPR(!autoPR)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  borderRadius: 6,
                  background: "var(--pi-bg)",
                  border: "1px solid var(--pi-hairline)",
                  color: "var(--pi-fg)",
                  fontSize: 12,
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    border: "1px solid var(--pi-hairline-strong)",
                    background: autoPR ? "var(--pi-fg)" : "transparent",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--pi-bg)",
                  }}
                >
                  {autoPR && <Icon name="check" size={10} stroke={3} />}
                </span>
                <span>Open PR automatically</span>
              </button>
            </Field>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: 8,
              borderTop: "1px solid var(--pi-hairline)",
            }}
          >
            <div style={{ color: "var(--pi-muted-2)", fontSize: 12 }}>
              Worktree:{" "}
              <span className="pi-mono" style={{ color: "var(--pi-muted)" }}>
                /tmp/wt/R-…
              </span>{" "}
              · branch from{" "}
              <span className="pi-mono" style={{ color: "var(--pi-muted)" }}>
                main
              </span>
            </div>
            <div style={{ display: "inline-flex", gap: 8 }}>
              <button
                onClick={closeSpawn}
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
                }}
              >
                Cancel
              </button>
              <button
                onClick={closeSpawn}
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
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <Icon name="spark" size={12} />
                Spawn run
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--pi-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
