import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const emptyStateVariants = cva("text-muted-foreground", {
  variants: {
    size: {
      sm: "text-xs",
      md: "text-sm",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export interface EmptyStateProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof emptyStateVariants> {}

// Empty states are one muted meta-voice line, nothing else.
export const EmptyState = React.forwardRef<HTMLParagraphElement, EmptyStateProps>(
  ({ className, size, ...props }, ref) => (
    <p ref={ref} className={cn(emptyStateVariants({ size }), className)} {...props} />
  )
);
EmptyState.displayName = "EmptyState";
