"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// The single sanctioned modal recipe (DESIGN.md §4): a backdrop-blur veil
// over the canvas and a shadow-xl card panel — the only permitted shadow in
// the system. Closes on Escape and on clicking the veil. Render it only when
// open; there is no `open` prop.
export function Modal({
  onClose,
  ariaLabel,
  className,
  veilClassName,
  children,
}: {
  onClose: () => void;
  ariaLabel?: string;
  /** Panel overrides, e.g. "max-w-sm". */
  className?: string;
  /** Veil overrides, e.g. a different z-index. */
  veilClassName?: string;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm px-4 animate-fade-in",
        veilClassName
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={cn(
          "w-full max-w-lg rounded-lg border border-border bg-card shadow-xl",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
