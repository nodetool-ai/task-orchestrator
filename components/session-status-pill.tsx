import type { SessionStatus } from "@/lib/types";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const labels: Record<SessionStatus, string> = {
  pending: "Pending",
  preparing: "Preparing",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  idle: "Idle",
  budget_exhausted: "Budget hit",
  closed: "Closed",
  parked: "Parked",
};

const tones: Record<SessionStatus, string> = {
  pending: "text-muted-foreground",
  preparing: "text-state-progress",
  running: "text-state-progress",
  completed: "text-state-done",
  failed: "text-state-blocked",
  cancelled: "text-muted-foreground",
  idle: "text-muted-foreground",
  budget_exhausted: "text-state-blocked",
  closed: "text-muted-foreground",
  parked: "text-state-review",
};

export function SessionStatusPill({
  status,
  className,
}: {
  status: SessionStatus;
  className?: string;
}) {
  const isLive = !["completed", "failed", "cancelled", "idle", "budget_exhausted", "closed"].includes(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/60 px-2 py-0.5 text-xs font-medium",
        tones[status],
        className
      )}
    >
      {isLive && <Spinner className="size-3" />}
      {labels[status]}
    </span>
  );
}
