import * as React from "react";
import { cn } from "@/lib/utils";

// Labeled form-field wrapper: meta-voice label (12px medium muted) above the
// control. Renders a <label> element so clicking the text focuses a directly
// nested control; pass htmlFor when the control lives deeper in the tree.
export function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={cn("block space-y-1", className)}>
      <span className="block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
