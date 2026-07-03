import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const errorTextVariants = cva("text-state-blocked", {
  variants: {
    size: {
      sm: "text-[11px]",
      md: "text-xs",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

export interface ErrorTextProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof errorTextVariants> {}

// Inline form/action error line. Renders nothing when children are empty.
export const ErrorText = React.forwardRef<HTMLParagraphElement, ErrorTextProps>(
  ({ className, size, children, ...props }, ref) => {
    if (children == null || children === false || children === "") return null;
    return (
      <p ref={ref} className={cn(errorTextVariants({ size }), className)} {...props}>
        {children}
      </p>
    );
  }
);
ErrorText.displayName = "ErrorText";
