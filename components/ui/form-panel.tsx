import * as React from "react";
import { cn } from "@/lib/utils";

export const FormPanel = React.forwardRef<HTMLFormElement, React.FormHTMLAttributes<HTMLFormElement>>(
  ({ className, ...props }, ref) => (
    <form
      ref={ref}
      className={cn(
        "space-y-2 rounded-md border border-border/60 bg-card/30 px-3 py-3",
        className
      )}
      {...props}
    />
  )
);
FormPanel.displayName = "FormPanel";
