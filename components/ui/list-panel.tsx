import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const listPanelVariants = cva(
  "overflow-hidden rounded-lg border border-border/60 bg-card/30",
  {
    variants: {
      divided: {
        true: "divide-y divide-border/60",
        false: "",
      },
    },
    defaultVariants: {
      divided: true,
    },
  }
);

export interface ListPanelProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof listPanelVariants> {}

export const ListPanel = React.forwardRef<HTMLDivElement, ListPanelProps>(
  ({ className, divided, ...props }, ref) => (
    <div ref={ref} className={cn(listPanelVariants({ divided }), className)} {...props} />
  )
);
ListPanel.displayName = "ListPanel";

export const ListPanelRow = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("px-3 py-2.5 transition-colors hover:bg-muted/40", className)}
    {...props}
  />
));
ListPanelRow.displayName = "ListPanelRow";
