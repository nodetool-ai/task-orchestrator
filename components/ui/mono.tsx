import * as React from "react";
import { cn } from "@/lib/utils";

// The Mono-As-Tag voice (DESIGN.md §3): an 11px tabular JetBrains Mono span
// for canonical, copyable literals — task ids, branch names, costs, paths.
// Never body copy.
export function Mono({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("font-mono text-[11px] tabular-nums", className)}
      {...props}
    />
  );
}
