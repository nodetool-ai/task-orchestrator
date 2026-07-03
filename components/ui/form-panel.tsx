import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const formPanelVariants = cva("rounded-md border border-border/60 bg-card/30", {
  variants: {
    spacing: {
      compact: "space-y-2 px-3 py-3",
      comfortable: "space-y-3 p-4",
    },
  },
  defaultVariants: {
    spacing: "compact",
  },
});

export interface FormPanelProps
  extends React.FormHTMLAttributes<HTMLFormElement>,
    VariantProps<typeof formPanelVariants> {}

export const FormPanel = React.forwardRef<HTMLFormElement, FormPanelProps>(
  ({ className, spacing, ...props }, ref) => (
    <form ref={ref} className={cn(formPanelVariants({ spacing }), className)} {...props} />
  )
);
FormPanel.displayName = "FormPanel";
