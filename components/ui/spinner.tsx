import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// The one sanctioned loading indicator (DESIGN.md §6: the motion vocabulary
// is fade-in plus this spin, nothing else). Size with className (size-3 in
// dense rows, size-4 in composer buttons).
export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn("size-3.5 animate-spin", className)} />;
}
