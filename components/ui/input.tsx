import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Field recipe from DESIGN.md §5. `md` is the standalone form field (ring
// focus); `sm`/`xs` are the dense inline-form fields (border-promotion focus).
// `mono` marks values sent to the system as literal strings (paths, branches).
const inputVariants = cva(
  "w-full border bg-background text-foreground placeholder:text-muted-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
  {
    variants: {
      uiSize: {
        md: "rounded-md border-border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/40",
        sm: "rounded-sm border-border/60 px-2 py-1.5 text-xs outline-none focus:border-foreground/40",
        xs: "rounded-sm border-border/60 px-2 py-1 text-xs outline-none focus:border-foreground/40",
      },
      mono: {
        true: "font-mono",
        false: "",
      },
    },
    defaultVariants: { uiSize: "md", mono: false },
  }
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, uiSize, mono, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(inputVariants({ uiSize, mono }), className)}
      {...props}
    />
  )
);
Input.displayName = "Input";

export { inputVariants };
