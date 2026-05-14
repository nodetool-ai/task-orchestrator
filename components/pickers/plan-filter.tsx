"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ListChecks } from "lucide-react";

export interface PlanOption {
  id: string;
  title: string;
}

interface Props {
  plans: PlanOption[];
  value: string | undefined;
  pathname?: string;
  size?: "default" | "compact";
  className?: string;
}

/**
 * URL-driven plan filter for the tasks index. Writes the selected plan id
 * into `?plan=<id>` (or removes the param for "All plans") and preserves
 * every other search param the page is reading.
 */
export function PlanFilter({
  plans,
  value,
  pathname = "/tasks",
  size = "default",
  className,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();

  function onChange(next: string) {
    const qs = new URLSearchParams(params?.toString() ?? "");
    if (next) qs.set("plan", next);
    else qs.delete("plan");
    const s = qs.toString();
    router.push(s ? `${pathname}?${s}` : pathname);
  }

  const cls =
    className ??
    (size === "compact"
      ? "rounded-sm border border-border/60 bg-background pl-6 pr-2 py-1 text-xs outline-none focus:border-foreground/40"
      : "rounded-md border border-border/60 bg-background pl-7 pr-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10 transition-colors");

  return (
    <span className="relative inline-block">
      <ListChecks
        className={
          size === "compact"
            ? "absolute left-1.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none"
            : "absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none"
        }
      />
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={cls}
        title="Plan"
        aria-label="Filter by plan"
      >
        <option value="">All plans</option>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
    </span>
  );
}
