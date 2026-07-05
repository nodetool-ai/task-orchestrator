"use client";

import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { BackendId } from "@/components/chat/use-model-options";

interface Props {
  /** null = catalog still loading (picker renders disabled). */
  value: BackendId | null;
  /** Backends offered by the server (deployment default first). */
  options: BackendId[];
  onChange: (next: BackendId) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}

/**
 * Agent-backend selector for the run-starting composers. Hidden while the
 * server offers fewer than two backends — with no real choice the extra
 * control is noise.
 */
export function BackendPicker({ value, options, onChange, disabled, className, id }: Props) {
  if (options.length < 2) return null;
  return (
    <Select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value as BackendId)}
      disabled={disabled || value == null}
      title="Agent backend"
      uiSize="sm"
      mono
      className={cn(
        "rounded-md border-border/60 bg-background/60 px-2 py-1 text-[11px] hover:bg-muted/40 focus:border-foreground/30 disabled:opacity-50",
        className
      )}
    >
      {options.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
    </Select>
  );
}
