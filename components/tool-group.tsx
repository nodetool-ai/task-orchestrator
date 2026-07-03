"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";

/**
 * Collapsible "N tools called" summary for a run of consecutive tool calls.
 * Collapsed by default (count only); expands to reveal the individual tool
 * cards passed as children.
 */
export function ToolGroup({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded-md border border-border/60 bg-background/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <Wrench className="size-3 shrink-0" />
        <span className="font-medium">
          {count} {count === 1 ? "tool" : "tools"} called
        </span>
      </button>
      {open && <div className="space-y-1.5 border-t border-border/40 px-2 py-2">{children}</div>}
    </div>
  );
}
