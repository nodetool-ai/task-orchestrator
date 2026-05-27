"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./primitives";
import { openPalette, openSpawn } from "./overlay-store";
import { SignOutButton } from "@/components/sign-out-button";
import { useIsMobile } from "./use-is-mobile";

const NAV: { id: string; href: string; label: string; icon: React.ComponentProps<typeof Icon>["name"] }[] = [
  { id: "floor", href: "/", label: "Floor", icon: "factory" },
  { id: "plans", href: "/plans", label: "Plans", icon: "plans" },
  { id: "tasks", href: "/tasks", label: "Tasks", icon: "tasks" },
  { id: "repos", href: "/repositories", label: "Repos", icon: "repos" },
  { id: "chat", href: "/chat", label: "Chat", icon: "chat" },
  { id: "personas", href: "/personas", label: "Personas", icon: "personas" },
  { id: "tokens", href: "/tokens", label: "Tokens", icon: "tokens" },
];

function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function TopNav({ email }: { email?: string }) {
  const pathname = usePathname() ?? "/";
  const isMobile = useIsMobile();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openSpawn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (isMobile) {
    return <TopNavMobile pathname={pathname} email={email} />;
  }

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        height: 48,
        padding: "0 20px",
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "hsla(240 6% 6% / 0.78)",
        backdropFilter: "blur(12px) saturate(140%)",
        WebkitBackdropFilter: "blur(12px) saturate(140%)",
        borderBottom: "1px solid var(--pi-hairline)",
      }}
    >
      <Link
        href="/"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          textDecoration: "none",
          padding: "0 8px 0 0",
          color: "var(--pi-fg)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: "var(--pi-fg)",
            color: "var(--pi-bg)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          <Icon name="pi" size={14} stroke={2} />
        </span>
        <span>Pi Factory</span>
      </Link>

      <div style={{ width: 12 }} />

      <nav style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {NAV.map((n) => {
          const active = isActive(n.href, pathname);
          return (
            <Link
              key={n.id}
              href={n.href}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 10px",
                borderRadius: 6,
                background: active ? "hsla(240 4% 18% / 0.7)" : "transparent",
                border: "1px solid",
                borderColor: active ? "var(--pi-hairline)" : "transparent",
                color: active ? "var(--pi-fg)" : "var(--pi-muted)",
                fontSize: 12,
                fontWeight: 500,
                textDecoration: "none",
                transition: "all 120ms",
              }}
            >
              <Icon name={n.icon} size={14} />
              <span>{n.label}</span>
            </Link>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <button
        onClick={openPalette}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px 6px 10px",
          borderRadius: 6,
          background: "hsla(240 4% 12% / 0.6)",
          border: "1px solid var(--pi-hairline)",
          color: "var(--pi-muted)",
          fontSize: 12,
          fontWeight: 500,
          minWidth: 220,
          justifyContent: "space-between",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="search" size={13} />
          Jump to task, run, plan…
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <kbd style={kbdStyle}>⌘</kbd>
          <kbd style={kbdStyle}>K</kbd>
        </span>
      </button>

      <button
        onClick={openSpawn}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          borderRadius: 6,
          background: "var(--pi-fg)",
          color: "var(--pi-bg)",
          border: "none",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
          marginLeft: 6,
        }}
      >
        <Icon name="spark" size={13} />
        Spawn agent
      </button>

      <div style={{ width: 8 }} />
      {email && (
        <span
          className="pi-mono"
          style={{ fontSize: 11, color: "var(--pi-muted)", display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {email}
          <SignOutButton />
        </span>
      )}
    </div>
  );
}

function TopNavMobile({ pathname, email }: { pathname: string; email?: string }) {
  const [menuOpen, setMenuOpen] = React.useState(false);

  React.useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  React.useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <>
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          height: 48,
          padding: "0 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "hsla(240 6% 6% / 0.85)",
          backdropFilter: "blur(12px) saturate(140%)",
          WebkitBackdropFilter: "blur(12px) saturate(140%)",
          borderBottom: "1px solid var(--pi-hairline)",
        }}
      >
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          style={iconBtnStyle}
        >
          <Icon name={menuOpen ? "x" : "tasks"} size={16} />
        </button>

        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            textDecoration: "none",
            color: "var(--pi-fg)",
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 5,
              background: "var(--pi-fg)",
              color: "var(--pi-bg)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            <Icon name="pi" size={14} stroke={2} />
          </span>
          <span>Pi Factory</span>
        </Link>

        <div style={{ flex: 1 }} />

        <button onClick={openPalette} aria-label="Search" style={iconBtnStyle}>
          <Icon name="search" size={15} />
        </button>
        <button
          onClick={openSpawn}
          aria-label="Spawn agent"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 6,
            background: "var(--pi-fg)",
            color: "var(--pi-bg)",
            border: "none",
            cursor: "pointer",
          }}
        >
          <Icon name="spark" size={14} />
        </button>
      </div>

      {menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            top: 48,
            zIndex: 49,
            background: "hsla(240 6% 4% / 0.6)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
          }}
        >
          <nav
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--pi-surface)",
              borderBottom: "1px solid var(--pi-hairline)",
              padding: "8px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              animation: "pi-fade-in 160ms ease-out",
            }}
          >
            {NAV.map((n) => {
              const active = isActive(n.href, pathname);
              return (
                <Link
                  key={n.id}
                  href={n.href}
                  onClick={() => setMenuOpen(false)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    borderRadius: 6,
                    background: active ? "var(--pi-raised)" : "transparent",
                    color: active ? "var(--pi-fg)" : "var(--pi-muted)",
                    fontSize: 14,
                    fontWeight: 500,
                    textDecoration: "none",
                    border: "1px solid",
                    borderColor: active ? "var(--pi-hairline)" : "transparent",
                  }}
                >
                  <Icon name={n.icon} size={16} />
                  <span>{n.label}</span>
                </Link>
              );
            })}
            {email && (
              <div
                style={{
                  marginTop: 8,
                  padding: "10px 14px",
                  borderTop: "1px solid var(--pi-hairline)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <span
                  className="pi-mono"
                  style={{
                    fontSize: 11,
                    color: "var(--pi-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {email}
                </span>
                <SignOutButton />
              </div>
            )}
          </nav>
        </div>
      )}
    </>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 6,
  background: "transparent",
  color: "var(--pi-muted)",
  border: "1px solid var(--pi-hairline)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const kbdStyle: React.CSSProperties = {
  font: "inherit",
  color: "var(--pi-muted-2)",
  padding: "1px 4px",
  border: "1px solid var(--pi-hairline)",
  borderRadius: 3,
  fontSize: 10,
};
