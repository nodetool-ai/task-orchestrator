import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Canonical button voices from DESIGN.md §5. Primary is inverted
// foreground-on-background (the State-Is-Accent Rule: no brand accent color);
// ghost is the nav / secondary voice; outline is the hairline utility voice;
// danger is reserved for destructive confirmation.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary: "bg-foreground text-background enabled:hover:opacity-90",
        ghost:
          "text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-muted/60",
        outline:
          "border border-border/60 text-muted-foreground enabled:hover:text-foreground enabled:hover:border-border",
        danger:
          "bg-state-blocked text-[hsl(240_6%_98%)] enabled:hover:bg-state-blocked/90",
      },
      size: {
        xs: "px-2.5 py-1 text-xs",
        sm: "px-3 py-1.5 text-xs",
        md: "px-3 py-2 text-sm",
        icon: "size-8 rounded-full",
      },
    },
    defaultVariants: { variant: "primary", size: "sm" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { buttonVariants };
