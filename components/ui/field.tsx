import * as React from "react";
import { cn } from "@/lib/utils";

export interface FieldProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  label: React.ReactNode;
}

// Labeled form-field wrapper: meta-voice label above the control.
export const Field = React.forwardRef<HTMLLabelElement, FieldProps>(
  ({ label, className, children, ...props }, ref) => (
    <label ref={ref} className={cn("block space-y-1", className)} {...props}>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
);
Field.displayName = "Field";
