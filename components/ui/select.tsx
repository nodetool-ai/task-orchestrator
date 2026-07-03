import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Native-select twin of the Input recipe (DESIGN.md §5). `md` is the
// standalone form field; `sm`/`xs` are the dense inline-composer sizes.
// `mono` marks selects whose values are literal strings (model ids, paths).
const selectVariants = cva(
  "border border-border/60 bg-background text-foreground transition-colors outline-none focus:border-foreground/40 disabled:opacity-40 disabled:cursor-not-allowed",
  {
    variants: {
      uiSize: {
        md: "rounded-md px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-foreground/10",
        sm: "rounded-sm px-2 py-1 text-xs",
        xs: "rounded-sm px-2 py-0.5 text-xs",
      },
      mono: {
        true: "font-mono",
        false: "",
      },
    },
    defaultVariants: { uiSize: "md", mono: false },
  }
);

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size">,
    VariantProps<typeof selectVariants> {}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, uiSize, mono, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(selectVariants({ uiSize, mono }), className)}
      {...props}
    />
  )
);
Select.displayName = "Select";

export { selectVariants };
