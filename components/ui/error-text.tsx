import * as React from "react";
import { cn } from "@/lib/utils";

// Inline form/action error line in Blocked Coral. Renders nothing when the
// message is empty so call sites can pass the error state directly.
export function ErrorText({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  if (children == null || children === false || children === "") return null;
  return <p className={cn("text-xs text-state-blocked", className)}>{children}</p>;
}
