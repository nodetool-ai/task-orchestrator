import * as React from "react";
import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const spinnerVariants = cva("animate-spin", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export interface SpinnerProps
  extends Omit<React.ComponentPropsWithoutRef<typeof Loader2>, "size">,
    VariantProps<typeof spinnerVariants> {}

// The one sanctioned loading indicator (DESIGN.md §6). Prefer the `size`
// variant; className remains available for dense one-off alignment.
export const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, size, ...props }, ref) => (
    <Loader2
      ref={ref}
      aria-hidden
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  )
);
Spinner.displayName = "Spinner";
