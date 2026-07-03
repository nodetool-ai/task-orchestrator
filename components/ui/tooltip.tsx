import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const tooltipBubbleVariants = cva(
  "pointer-events-none absolute left-1/2 z-50 max-w-xs -translate-x-1/2 whitespace-nowrap rounded-md border border-border/70 bg-card px-2 py-1 font-sans text-[11px] font-medium text-foreground opacity-0 transition-opacity delay-150 duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
  {
    variants: {
      side: {
        top: "bottom-full mb-1.5",
        bottom: "top-full mt-1.5",
      },
    },
    defaultVariants: {
      side: "top",
    },
  }
);

export interface TooltipProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "content">,
    VariantProps<typeof tooltipBubbleVariants> {
  content: React.ReactNode;
  bubbleClassName?: string;
}

export const Tooltip = React.forwardRef<HTMLSpanElement, TooltipProps>(
  ({ content, children, className, bubbleClassName, side, ...props }, ref) => {
    if (content == null || content === "") return <>{children}</>;

    return (
      <span
        ref={ref}
        className={cn("group/tooltip relative inline-flex min-w-0", className)}
        {...props}
      >
        {children}
        <span
          role="tooltip"
          className={cn(tooltipBubbleVariants({ side }), bubbleClassName)}
        >
          {content}
        </span>
      </span>
    );
  }
);
Tooltip.displayName = "Tooltip";
