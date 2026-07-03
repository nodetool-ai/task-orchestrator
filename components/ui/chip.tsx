import type * as React from "react";
import { cn } from "@/lib/utils";

type ChipTone = "neutral" | "danger";

interface ChipStyleProps {
  selected?: boolean;
  tone?: ChipTone;
  mono?: boolean;
  className?: string;
}

const base =
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors";

function chipClass({ selected = false, tone = "neutral", mono, className }: ChipStyleProps) {
  return cn(
    base,
    mono && "font-mono text-[11px] font-normal",
    tone === "danger" &&
      (selected
        ? "border-state-blocked/40 bg-state-blocked/80 text-background hover:bg-state-blocked"
        : "border-state-blocked/30 bg-state-blocked/5 text-state-blocked hover:bg-state-blocked/10"),
    tone === "neutral" &&
      (selected
        ? "border-foreground/40 bg-foreground/10 text-foreground hover:bg-foreground/15"
        : "border-border/60 bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground"),
    className
  );
}

export function Chip({ selected, tone, mono, className, ...props }: React.HTMLAttributes<HTMLSpanElement> & ChipStyleProps) {
  return <span className={chipClass({ selected, tone, mono, className })} {...props} />;
}

export function ChipButton({ selected, tone, mono, className, type = "button", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & ChipStyleProps) {
  return <button type={type} className={chipClass({ selected, tone, mono, className })} {...props} />;
}
