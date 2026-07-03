import * as React from "react";
import { cn } from "@/lib/utils";

// Empty states are one muted meta-voice line, nothing else — no
// illustration, no CTA, no encouragement (DESIGN.md §6).
export function EmptyState({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <p className={cn("text-xs text-muted-foreground", className)}>{children}</p>;
}
