import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  bubbleClassName?: string;
  side?: "top" | "bottom";
}

export function Tooltip({ content, children, className, bubbleClassName, side = "top" }: TooltipProps) {
  if (content == null || content === "") return <>{children}</>;

  return (
    <span className={cn("group/tooltip relative inline-flex min-w-0", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 max-w-xs -translate-x-1/2 whitespace-nowrap rounded-md border border-border/70 bg-card px-2 py-1 font-sans text-[11px] font-medium text-foreground opacity-0 transition-opacity delay-150 duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          bubbleClassName
        )}
      >
        {content}
      </span>
    </span>
  );
}
