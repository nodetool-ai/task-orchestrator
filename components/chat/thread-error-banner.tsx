"use client";

import { CircleAlert, X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

interface Props {
  error: string | null;
  onDismiss?: () => void;
}

export function ThreadErrorBanner({ error, onDismiss }: Props) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-state-blocked/40 bg-state-blocked/10 px-3 py-2 text-[12px] text-state-blocked"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <Tooltip content={error} className="min-w-0 flex-1">
        <p className="line-clamp-3 leading-5">{error}</p>
      </Tooltip>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss error"
          onClick={onDismiss}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-state-blocked/70 transition-colors hover:text-state-blocked"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
