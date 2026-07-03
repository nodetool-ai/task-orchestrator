import * as React from "react";
import { cn } from "@/lib/utils";

export interface TypingDotsProps extends React.HTMLAttributes<HTMLSpanElement> {
  dotClassName?: string;
  label?: string;
}

export const TypingDots = React.forwardRef<HTMLSpanElement, TypingDotsProps>(
  ({ className, dotClassName, label = "Thinking", ...props }, ref) => (
    <span
      ref={ref}
      className={cn("inline-flex items-center gap-1", className)}
      aria-label={label}
      {...props}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full bg-foreground/60 animate-pulse", dotClassName)}
      />
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-foreground/60 animate-pulse [animation-delay:120ms]",
          dotClassName
        )}
      />
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-foreground/60 animate-pulse [animation-delay:240ms]",
          dotClassName
        )}
      />
    </span>
  )
);
TypingDots.displayName = "TypingDots";
