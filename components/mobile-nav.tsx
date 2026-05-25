"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Menu, X, LayoutDashboard, ListTodo, Target, Activity, FolderGit2, MessageCircle, Users, KeyRound } from "lucide-react";

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/plans", label: "Plans", icon: Target },
  { href: "/repositories", label: "Repos", icon: FolderGit2 },
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/personas", label: "Personas", icon: Users },
  { href: "/tokens", label: "Tokens", icon: KeyRound },
];

export function MobileNav({ email }: { email?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex md:hidden items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>

      {open && (
        <div
          className="fixed inset-0 top-12 z-30 bg-background/95 backdrop-blur-sm md:hidden"
          onClick={() => setOpen(false)}
        >
          <nav className="flex flex-col border-b border-border/60 bg-background shadow-lg">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-5 py-3.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 border-b border-border/40 last:border-0 transition-colors"
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
              </Link>
            ))}
            {email && (
              <div className="px-5 py-3.5 text-xs text-muted-foreground font-mono border-t border-border/60 bg-secondary/20">
                {email}
              </div>
            )}
          </nav>
        </div>
      )}
    </>
  );
}
